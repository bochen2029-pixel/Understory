#!/usr/bin/env python3
"""Bonsai end-to-end smoke test.

Hits the same llama-server HTTP endpoint the desktop app uses and exercises:
  1. /health
  2. streaming chat with THINKING ON  (reasoning_content + content channels)
  3. streaming chat with THINKING OFF (direct answer)
  4. reports decode throughput (tok/s)

Run while the app (or a bare llama-server) is up on :8080:
    python smoke_test.py
"""
import json
import sys
import time
import urllib.request

BASE = "http://127.0.0.1:8080"


def health() -> bool:
    try:
        with urllib.request.urlopen(f"{BASE}/health", timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


def stream_chat(prompt: str, thinking: bool) -> None:
    body = {
        "messages": [
            {"role": "system", "content": "You are a helpful assistant"},
            {"role": "user", "content": prompt},
        ],
        "stream": True,
        "stream_options": {"include_usage": True},
        "temperature": 0.7,
        "top_p": 0.95,
        "top_k": 20,
        "max_tokens": 400,
    }
    if not thinking:
        body["chat_template_kwargs"] = {"enable_thinking": False}

    req = urllib.request.Request(
        f"{BASE}/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    reasoning, answer, tps = [], [], None
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=120) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "ignore").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            t = chunk.get("timings") or {}
            if t.get("predicted_per_second"):
                tps = t["predicted_per_second"]
            for ch in chunk.get("choices", []):
                d = ch.get("delta", {})
                if d.get("reasoning_content"):
                    reasoning.append(d["reasoning_content"])
                if d.get("content"):
                    answer.append(d["content"])
    dt = time.time() - t0
    mode = "THINKING ON " if thinking else "THINKING OFF"
    print(f"\n=== {mode} | prompt: {prompt!r} ===")
    if reasoning:
        r = "".join(reasoning)
        print(f"[reasoning: {len(r)} chars] {r[:160]}{'…' if len(r) > 160 else ''}")
    print(f"[answer] {''.join(answer).strip()[:600]}")
    print(f"[stats] {dt:.1f}s wall" + (f" · {tps:.1f} tok/s decode" if tps else ""))


def main() -> int:
    print("Bonsai smoke test →", BASE)
    if not health():
        print("FAIL: /health not reachable. Is the app / llama-server running on :8080?")
        return 1
    print("OK: /health 200")
    stream_chat("In one sentence, what is a bonsai tree?", thinking=False)
    stream_chat("A farmer has 17 sheep; all but 9 run away. How many are left? Explain.", thinking=True)
    print("\nSMOKE TEST PASSED ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
