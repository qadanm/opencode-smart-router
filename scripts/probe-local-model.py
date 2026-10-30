#!/usr/bin/env python3
"""
Probe the local model through Ollama's HTTP API and report real measurements.

Exists because shell-quoting JSON through curl breaks on control characters in
model output, which silently corrupts the very measurements being collected.
Everything here is a plain HTTP request built in Python.

Subcommands:
  text      code generation quality and timing
  think     how many tokens the thinking phase consumes
  vision    image input, using a real PNG
  tools     native tool calling
  memory    resident memory while loaded

Every number printed is measured on this machine. Nothing is estimated unless
the line says so.
"""

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("OLLAMA_BASE", "http://127.0.0.1:11434")
MODEL = os.environ.get("OLLAMA_MODEL", "qwen3.5:4b-q4_K_M")


def post(path, payload, timeout=600):
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def get(path, timeout=30):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def chat(messages, num_predict=800, num_ctx=8192, temperature=0.2, tools=None):
    payload = {
        "model": MODEL,
        "messages": messages,
        "stream": False,
        "options": {"num_ctx": num_ctx, "num_predict": num_predict, "temperature": temperature},
    }
    if tools:
        payload["tools"] = tools
    return post("/api/chat", payload)


def report(label, data):
    message = data.get("message") or {}
    thinking = message.get("thinking") or ""
    content = message.get("content") or ""
    eval_count = data.get("eval_count") or 0
    print(f"--- {label} ---")
    print(f"  eval_count        {eval_count}")
    print(f"  prompt_eval_count {data.get('prompt_eval_count')}")
    print(f"  thinking_chars    {len(thinking)}")
    print(f"  content_chars     {len(content)}")
    total = (data.get("total_duration") or 0) / 1e6
    load = (data.get("load_duration") or 0) / 1e6
    eval_ms = (data.get("eval_duration") or 0) / 1e6
    prompt_ms = (data.get("prompt_eval_duration") or 0) / 1e6
    print(f"  load_ms           {load:.0f}")
    print(f"  prompt_ms         {prompt_ms:.0f}")
    print(f"  eval_ms           {eval_ms:.0f}")
    print(f"  total_ms          {total:.0f}")
    if eval_count and eval_ms > 0:
        print(f"  gen_tokens_per_s  {eval_count / (eval_ms / 1000):.1f}")
    if data.get("prompt_eval_count") and prompt_ms > 0:
        print(f"  prompt_tok_per_s  {data['prompt_eval_count'] / (prompt_ms / 1000):.1f}")
    return thinking, content


def cmd_text(args):
    prompt = (
        "Write a React Native TypeScript component named Pill that renders a "
        "Pressable containing Text. Props: label string, onPress () => void, "
        "active boolean. Use a StyleSheet with padding 8, borderRadius 999, "
        "and a background that changes when active. Return only the code."
    )
    started = time.time()
    data = chat([{"role": "user", "content": prompt}], num_predict=args.num_predict)
    wall = time.time() - started
    _, content = report("text/code generation", data)
    print(f"  wall_seconds      {wall:.1f}")
    print("--- content ---")
    print(content)


def cmd_think(args):
    prompt = (
        "Write a minimal React Native TSX Badge component with props label and "
        "tone. Only code."
    )
    print(f"model={MODEL} num_ctx={args.num_ctx}")
    print(f"{'num_predict':>12} {'eval':>6} {'thinking':>10} {'content':>9} {'complete':>9}")
    for num_predict in (200, 400, 800, 1600, 3000):
        data = chat(
            [{"role": "user", "content": prompt}],
            num_predict=num_predict,
            num_ctx=args.num_ctx,
        )
        message = data.get("message") or {}
        thinking = len(message.get("thinking") or "")
        content = len(message.get("content") or "")
        print(
            f"{num_predict:>12} {data.get('eval_count'):>6} {thinking:>10} {content:>9} "
            f"{str(content > 200):>9}"
        )


def cmd_vision(args):
    path = args.image
    if not os.path.exists(path):
        sys.exit(f"image not found: {path}")
    with open(path, "rb") as handle:
        b64 = base64.b64encode(handle.read()).decode("ascii")
    size = os.path.getsize(path)
    print(f"image: {path} ({size:,} bytes)")

    prompt = (
        "This is a screenshot of a mobile app. Describe only what you can "
        "actually see about layout problems: anything clipped at the edges, "
        "text truncated, elements overlapping, or uneven spacing. If none of "
        "those are visible, say so plainly. Do not speculate about code."
    )
    started = time.time()
    data = chat(
        [{"role": "user", "content": prompt, "images": [b64]}],
        num_predict=args.num_predict,
    )
    wall = time.time() - started
    _, content = report("vision", data)
    print(f"  wall_seconds      {wall:.1f}")
    print("--- content ---")
    print(content)


def cmd_tools(args):
    tools = [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file from the local project.",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string", "description": "File path"}},
                    "required": ["path"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "run_shell",
                "description": "Run a shell command in the project.",
                "parameters": {
                    "type": "object",
                    "properties": {"command": {"type": "string"}},
                    "required": ["command"],
                },
            },
        },
    ]
    messages = [
        {
            "role": "user",
            "content": "Read the file src/components/Badge.tsx so we can look at its styles.",
        }
    ]
    data = chat(messages, num_predict=600, tools=tools)
    message = data.get("message") or {}
    calls = message.get("tool_calls") or []
    print(f"--- tool calling ---")
    print(f"  tool_calls        {len(calls)}")
    print(f"  content_chars     {len(message.get('content') or '')}")
    for call in calls:
        fn = call.get("function") or {}
        print(f"  -> {fn.get('name')}({json.dumps(fn.get('arguments'))})")

    if calls:
        # Feed the result back and check the model continues sanely rather than
        # repeating the call forever, which is the common 4B failure mode.
        messages.append(message)
        messages.append(
            {
                "role": "tool",
                "content": json.dumps(
                    {
                        "path": "src/components/Badge.tsx",
                        "content": "export const Badge = () => null // placeholder",
                    }
                ),
            }
        )
        follow = chat(messages, num_predict=600, tools=tools)
        follow_message = follow.get("message") or {}
        follow_calls = follow_message.get("tool_calls") or []
        print(f"  after tool result: tool_calls={len(follow_calls)}")
        print(f"  after tool result content: {(follow_message.get('content') or '')[:300]}")
        repeated = [c.get("function", {}).get("name") for c in follow_calls]
        print(f"  repeated same call: {repeated}")


def cmd_memory(args):
    data = get("/api/ps")
    for model in data.get("models") or []:
        print(f"model            {model.get('name')}")
        print(f"  size_bytes     {model.get('size'):,} ({model.get('size', 0) / 1e9:.2f} GB)")
        print(f"  size_vram      {model.get('size_vram'):,} ({model.get('size_vram', 0) / 1e9:.2f} GB)")
        print(f"  context        {model.get('context_length') or model.get('context')}")
        print(f"  expires_at     {model.get('expires_at')}")
    if not data.get("models"):
        print("no model currently loaded")
    for name, cmd in (
        ("ollama_rss", "ps -o rss= -p $(pgrep -f 'ollama serve' | head -1)"),
        ("runner_rss", "ps -o rss= -p $(pgrep -f 'ollama runner' | head -1)"),
    ):
        try:
            out = subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout.strip()
            if out:
                print(f"{name:<16} {int(out) / 1024 / 1024:.2f} GB")
        except Exception:
            pass
    try:
        swap = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout.strip()
        print(f"swap             {swap}")
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["text", "think", "vision", "tools", "memory"])
    parser.add_argument("--image", default="/tmp/offline-probe.png")
    parser.add_argument("--num-predict", type=int, default=800)
    parser.add_argument("--num-ctx", type=int, default=8192)
    args = parser.parse_args()
    {
        "text": cmd_text,
        "think": cmd_think,
        "vision": cmd_vision,
        "tools": cmd_tools,
        "memory": cmd_memory,
    }[args.command](args)


if __name__ == "__main__":
    main()
