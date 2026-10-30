#!/usr/bin/env python3
"""
Controlled single probe: does OpenDesign's gateway accept a deepseek-v4.1-flash
request whose input exceeds the advertised context_budget of 328,000?

Design constraints:
  - ONE request. max_tokens=1 so output cost is negligible.
  - Synthetic filler only. No real data, no source code, no prompts.
  - Does not touch any OpenCode session, config, or router state.
  - Reads the key but never prints it.

Cost: ~350,000 input tokens at $0.15/M is about $0.05 of the plan models pool.

Outcome mapping:
  200  -> the gateway accepted >328k input; context_budget is not a hard cap.
  400 with a context/token message -> the budget is enforced at some boundary.
  other -> inconclusive; report exactly what came back.
"""

import json
import os
import sys
import urllib.error
import urllib.request

BASE = "https://amr-link.open-design.ai/v1"
MODEL = "deepseek-v4.1-flash"
KEY_PATH = os.path.expanduser("~/.config/opencode/opendesign.key")

# "The quick brown fox jumps over the lazy dog. " is about 4.5 chars/token.
# 1,600,000 chars lands near 350k tokens, deliberately above 328,000 but not
# wasteful.
FILLER = "The quick brown fox jumps over the lazy dog. "
TARGET_CHARS = 1_600_000

key = open(KEY_PATH).read().strip()
if not key:
    sys.exit("no key")

reps = TARGET_CHARS // len(FILLER)
body = FILLER * reps
print(f"filler: {reps:,} reps, {len(body):,} chars (~{len(body)/4.5:,.0f} tokens est.)")

payload = {
    "model": MODEL,
    # Instruction at the very end so the request is a normal completion, not a
    # bare blob. It asks for one token, so the reply is trivial.
    "messages": [
        {"role": "user", "content": body + "\n\nReply with the single word: ok"},
    ],
    "max_tokens": 1,
    "stream": False,
}

data = json.dumps(payload).encode()
print(f"payload: {len(data):,} bytes")

req = urllib.request.Request(
    f"{BASE}/chat/completions",
    data=data,
    headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    },
    method="POST",
)

try:
    with urllib.request.urlopen(req, timeout=300) as resp:
        status = resp.status
        raw = resp.read().decode(errors="replace")
except urllib.error.HTTPError as e:
    status = e.code
    raw = e.read().decode(errors="replace")
except Exception as e:
    status = "network-error"
    raw = f"{type(e).__name__}: {e}"

print(f"\nHTTP {status}")
try:
    parsed = json.loads(raw)
    print("usage:", json.dumps(parsed.get("usage"), indent=1))
    if parsed.get("error"):
        print("error:", json.dumps(parsed["error"])[:600])
    choice = (parsed.get("choices") or [{}])[0]
    print("finish_reason:", choice.get("finish_reason"))
    print("content:", json.dumps((choice.get("message") or {}).get("content"))[:200])
except Exception:
    print("body:", raw[:800])
