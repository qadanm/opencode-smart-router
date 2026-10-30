#!/usr/bin/env python3
"""
Score the local vision model against fixtures with known, planted defects.

A real screenshot has no ground truth: "the modal overlaps the content" might be
a correct observation or a description of intended UI. This runs the model over
two images that differ only by four specific faults, so the answer can be scored
instead of admired.

Metrics, all measured:
  - recall     how many planted faults the model names on the broken image
  - precision  whether it invents faults on the clean image
  - latency    wall seconds per image
  - tokens     image tokens consumed, which is what constrains an 8K window

Usage:  python3 scripts/score-vision.py [--reasoning none|default]
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.request

BASE = os.environ.get("OLLAMA_BASE", "http://127.0.0.1:11434")
MODEL = os.environ.get("OLLAMA_MODEL", "qwen3.5:4b-q4_K_M")
FIXTURES = os.environ.get("FIXTURE_DIR", "/tmp/offline-fixtures")

PROMPT = (
    "You are reviewing a mobile app screenshot for layout defects. Look only at "
    "what is visibly wrong. Report each problem on its own line, prefixed with "
    "one of: CLIPPING, OVERLAP, TRUNCATION, SPACING. If a category has no visible "
    "problem, do not mention it. Be specific about which text or element is affected."
)

# Each planted fault, with the words a correct answer would plausibly use.
FAULTS = {
    "clipping": ["clip", "cut off", "cut mid", "overflow", "runs off", "past the edge", "truncat"],
    "overlap": ["overlap", "collid", "on top of", "superimpos", "stacked on"],
    "truncation": ["continu", "ellipsis", "…", "truncat", "shorten"],
    "spacing": ["uneven", "inconsistent gap", "too much space", "irregular spacing", "gap"],
}


def ask(image_path, reasoning):
    with open(image_path, "rb") as handle:
        b64 = base64.b64encode(handle.read()).decode("ascii")
    payload = {
        "model": MODEL,
        "max_tokens": 500,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                ],
            }
        ],
    }
    if reasoning == "none":
        payload["reasoning_effort"] = "none"
    started = time.time()
    request = urllib.request.Request(
        f"{BASE}/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=900) as response:
        data = json.loads(response.read().decode("utf-8"))
    wall = time.time() - started
    choice = data["choices"][0]
    return {
        "text": choice["message"].get("content") or "",
        "finish": choice.get("finish_reason"),
        "wall": wall,
        "prompt_tokens": (data.get("usage") or {}).get("prompt_tokens"),
        "completion_tokens": (data.get("usage") or {}).get("completion_tokens"),
    }


def found_faults(text):
    low = text.lower()
    hits = set()
    for name, needles in FAULTS.items():
        if any(needle in low for needle in needles):
            hits.add(name)
    return hits


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reasoning", choices=["none", "default"], default="none")
    args = parser.parse_args()

    broken = os.path.join(FIXTURES, "layout-broken.png")
    clean = os.path.join(FIXTURES, "layout-clean.png")
    for path in (broken, clean):
        if not os.path.exists(path):
            sys.exit(f"missing fixture: {path}\nrun scripts/make-vision-fixtures.py first")

    print(f"model={MODEL} reasoning={args.reasoning}")
    print()

    b = ask(broken, args.reasoning)
    print(f"=== broken image ({b['wall']:.1f}s, {b['prompt_tokens']} prompt tok, "
          f"{b['completion_tokens']} out, finish={b['finish']}) ===")
    print(b["text"].strip() or "(empty)")
    print()
    b_hits = found_faults(b["text"])
    print(f"recall: {len(b_hits)}/{len(FAULTS)} -> {sorted(b_hits)}")
    missed = sorted(set(FAULTS) - b_hits)
    if missed:
        print(f"missed: {missed}")
    print()

    c = ask(clean, args.reasoning)
    print(f"=== clean image ({c['wall']:.1f}s, {c['prompt_tokens']} prompt tok, "
          f"{c['completion_tokens']} out, finish={c['finish']}) ===")
    print(c["text"].strip() or "(empty)")
    print()
    c_hits = found_faults(c["text"])
    # On the clean image any confident fault claim is a false positive. Mentions
    # of a category in a "no X visible" form are not.
    # A fault named on the clean image is a false positive, unless the answer
    # explicitly denies it ("no clipping visible"). The check is per-fault so a
    # blanket "no problems" cannot excuse a specific invented claim.
    low = c["text"].lower()
    invented = set()
    for name in c_hits:
        denied = any(
            phrase in low
            for phrase in (
                f"no {name}",
                f"no visible {name}",
                f"{name}: none",
                f"no obvious {name}",
            )
        )
        if not denied:
            invented.add(name)
    print(f"false positives on clean image: {sorted(invented) if invented else 'none'}")
    print()
    print(f"summary: recall {len(b_hits)}/{len(FAULTS)}, "
          f"false_positive_categories {len(invented)}, "
          f"avg_wall {(b['wall'] + c['wall']) / 2:.1f}s, "
          f"avg_image_tokens {((b['prompt_tokens'] or 0) + (c['prompt_tokens'] or 0)) // 2}")


if __name__ == "__main__":
    main()
