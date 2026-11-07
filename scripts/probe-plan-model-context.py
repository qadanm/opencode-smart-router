#!/usr/bin/env python3
"""
Context-window probes for OpenDesign plan models (Sonnet 5.5, GPT-6.1 Sol).

Purpose (owner instruction 2026-11-06): verify at least 800K input tokens
end-to-end on each flagship before the router's catalog may raise the measured
context values (Sonnet 328K, Sol 400K). A probe that merely returns 200 is NOT
sufficient evidence: filler must be unique (so no prefix cache can inflate the
token count invisibly) and the reply must prove the model actually saw tokens
placed at the beginning, middle, and end of the prompt.

Protocol per model:
  1. Build one user message:
       - sentinel A + unique random filler
       - sentinel B + unique random filler
       - sentinel C + unique random filler
     Each sentinel is a fixed memorable token (e.g. CRIMSON-FALCON-42).
  2. Single request, chat-completions endpoint, stream=False.
  3. Pass criteria, all required:
       - HTTP 200
       - usage.prompt_tokens >= 800_000
       - reply names all three sentinels
       - finish_reason == "stop" (not "length", which would mean truncation)
       - usage.completion_tokens < max_tokens (no silent output cutoff)
  4. Record exact usage and cost from usage fields.

Budget: hard cap $6.00 combined across both probes (authorized ~$5, max $6).
The script refuses to fire a probe whose estimated cost would exceed the
remaining budget. Estimated before sending from the catalog prices; actual
spend is read back from usage.

Cost estimate at 820K input tokens (no cache possible - filler is random):
  Sonnet: 0.82M x $2/M          ~= $1.64   + output (<= 512 tokens x $10/M = $0.005)
  Sol:    (0.272 x $2) + (0.548 x $4)/M = $0.54 + $2.19 = $2.73 + output
Combined ~= $4.38, inside the ~$5 authorization with margin for one retry
each at reduced size if the first attempt hits a gateway hiccup.

Synthetic filler only. No real data, no source code. Reads the key at
~/.config/opencode/opendesign.key and never prints it.
"""

import json
import os
import random
import string
import sys
import time
import urllib.error
import urllib.request

BASE = "https://amr-link.open-design.ai/v1"
KEY_PATH = os.path.expanduser("~/.config/opencode/opendesign.key")
BUDGET_CAP_USD = 6.00

# Catalog prices, $/M tokens: (input, output). Sol's long-context tier above
# 272K input doubles the input price and raises output to 15.
PRICES = {
    "claude-sonnet-5.5": {"input": 2.0, "output": 10.0, "long_input": 2.0, "long_output": 10.0, "tier_at": 0},
    "gpt-6.1-sol": {"input": 2.0, "output": 10.0, "long_input": 4.0, "long_output": 15.0, "tier_at": 272_000},
}

TARGET_TOKENS = 820_000
# Measured chars-per-token for this filler, per model tokenizer:
#   2026-11-06 Sonnet: 1,000,400 chars -> 819,383 tokens (1.2208 c/t)
#   2026-11-06 Sol:    1,001,100 chars -> 626,403 tokens (1.5985 c/t)
CHARS_PER_TOKEN = {"claude-sonnet-5.5": 1.2208, "gpt-6.1-sol": 1.5985}
MAX_TOKENS = 512

SENTINELS = ("CRIMSON-FALCON-42", "AZURE-ANCHOR-77", "VIOLET-HARBOR-19")

spent_usd = 0.0


def random_filler(target_chars: int, rng: random.Random) -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(rng.choices(alphabet, k=target_chars))


def estimate_cost(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    p = PRICES[model]
    if prompt_tokens <= p["tier_at"]:
        input_cost = prompt_tokens / 1e6 * p["input"]
        output_cost = completion_tokens / 1e6 * p["output"]
    else:
        input_cost = (
            p["tier_at"] / 1e6 * p["input"] + (prompt_tokens - p["tier_at"]) / 1e6 * p["long_input"]
        )
        output_cost = completion_tokens / 1e6 * p["long_output"]
    return input_cost + output_cost


def build_payload(model: str) -> dict:
    rng = random.Random()  # os-random, never seeded: uniqueness is the cache control
    # Filler chars for the target token count under this model's measured
    # tokenizer density, split into three blocks.
    block_chars = int(TARGET_TOKENS * CHARS_PER_TOKEN[model] / 3)
    blocks = []
    for sentinel in SENTINELS:
        blocks.append(
            f"MEMORIZATION MARKER {sentinel}: this marker must be reported verbatim later.\n\n"
            + random_filler(block_chars, rng)
        )
    prompt = (
        "You are part of a storage-integrity verification. Three memorization markers are "
        "hidden in the text below at the beginning, the middle, and the end. After the text "
        "you will be asked to report them.\n\n"
        + blocks[0]
        + "\n\n"
        + blocks[1]
        + "\n\n"
        + blocks[2]
        + "\n\nEND OF DOCUMENT. Now report the three memorization markers you read, as a plain "
        "list of their exact codes, and nothing else."
    )
    # The gateway's JSON encoder may reject code points outside the BMP
    # (surrogate pairs appear in some random draws) - restrict to ASCII.
    prompt = prompt.encode("ascii", "ignore").decode("ascii")
    return {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": MAX_TOKENS,
        "stream": False,
    }


def fire(model: str, payload: dict) -> dict:
    global spent_usd
    data = json.dumps(payload).encode()
    est = estimate_cost(model, TARGET_TOKENS, MAX_TOKENS)
    if spent_usd + est > BUDGET_CAP_USD:
        return {"status": "budget-stop", "detail": f"estimated ${est:.2f} would exceed the ${BUDGET_CAP_USD:.2f} cap (spent ${spent_usd:.2f})"}
    print(f"  payload: {len(data):,} bytes, est cost <= ${est:.2f}, spent so far ${spent_usd:.2f}")
    req = urllib.request.Request(
        f"{BASE}/chat/completions",
        data=data,
        headers={"Authorization": f"Bearer {open(KEY_PATH).read().strip()}", "Content-Type": "application/json"},
        method="POST",
    )
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            status, raw = resp.status, resp.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read().decode(errors="replace")
    except Exception as e:
        return {"status": "network-error", "detail": f"{type(e).__name__}: {e}"}
    elapsed = time.time() - started
    try:
        parsed = json.loads(raw)
    except Exception:
        return {"status": status, "detail": f"unparseable body: {raw[:300]}"}
    if status != 200:
        return {"status": status, "detail": json.dumps(parsed.get("error", parsed))[:400]}
    usage = parsed.get("usage") or {}
    prompt_tokens = usage.get("prompt_tokens") or 0
    completion_tokens = usage.get("completion_tokens") or 0
    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
    choice = (parsed.get("choices") or [{}])[0]
    finish = choice.get("finish_reason")
    content = (choice.get("message") or {}).get("content") or ""
    # The gateway reports authoritative per-request cost when it bills the
    # pool; fall back to the catalog estimate only if it does not.
    reported = (usage.get("cost") or {}).get("total_cost")
    actual = float(reported) if isinstance(reported, (int, float)) else estimate_cost(model, prompt_tokens, completion_tokens)
    spent_usd += actual
    found = [s for s in SENTINELS if s in content]
    return {
        "status": 200,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "cached_tokens": cached,
        "finish_reason": finish,
        "sentinels_found": found,
        "sentinels_missing": [s for s in SENTINELS if s not in content],
        "content_head": content[:160],
        "cost_usd": round(actual, 4),
        "elapsed_s": round(elapsed, 1),
        "truncated_output": finish == "length" or completion_tokens >= MAX_TOKENS,
    }


def verdict(r: dict) -> tuple[bool, list]:
    if r.get("status") != 200:
        return False, [f"HTTP {r.get('status')}: {r.get('detail', '')[:200]}"]
    fails = []
    if r["prompt_tokens"] < 800_000:
        fails.append(f"prompt_tokens {r['prompt_tokens']:,} < 800,000")
    if r["sentinels_missing"]:
        fails.append(f"sentinels not retrieved: {r['sentinels_missing']}")
    if r["finish_reason"] != "stop":
        fails.append(f"finish_reason {r['finish_reason']!r}")
    if r["truncated_output"]:
        fails.append("output hit max_tokens (possible silent cutoff)")
    if r["cached_tokens"] > r["prompt_tokens"] * 0.5:
        fails.append(f"cached_tokens {r['cached_tokens']:,} on random filler - tokenization suspect")
    return (len(fails) == 0), fails


def main() -> int:
    only = sys.argv[1] if len(sys.argv) > 1 else None
    models = ["claude-sonnet-5.5", "gpt-6.1-sol"]
    if only:
        models = [m for m in models if only in m]
    results = {}
    for model in models:
        print(f"\n=== probing {model} at ~{TARGET_TOKENS:,} input tokens ===")
        payload = build_payload(model)
        r = fire(model, payload)
        ok, fails = verdict(r)
        results[model] = {"result": r, "pass": ok, "failures": fails}
        print(json.dumps(r, indent=1)[:900])
        print(f"  VERDICT: {'PASS' if ok else 'FAIL'}" + ("" if ok else f" - {'; '.join(fails)}"))
    print(f"\nTOTAL SPENT: ${spent_usd:.2f} of ${BUDGET_CAP_USD:.2f} cap")
    out = os.path.expanduser("~/.opencode-smart-router/.superpowers/sdd/2026-11-06-auto-flagship/context-probe-results.json")
    with open(out, "w") as f:
        json.dump({"at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "results": results, "spent_usd": round(spent_usd, 4)}, f, indent=1)
    print(f"saved: {out}")
    return 0 if all(r["pass"] for r in results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
