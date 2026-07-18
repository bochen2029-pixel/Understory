#!/usr/bin/env python3
"""Capture per-token uncertainty for a few prompts to drive the tree prototype.

Outputs a JSON file: { prompts: [ { label, question, answer, tokens: [
  {token, surprisal, entropy, margin} ] } ] }

Run against the live llama-server (the app's, or a bare one) on :8080.
"""
import json
import math
import urllib.request

BASE = "http://127.0.0.1:8080"

PROMPTS = [
    ("known", "What is 2 plus 2? Answer in one short sentence."),
    ("titanic", "Who was the captain of the RMS Titanic? Answer in one sentence."),
    ("obscure", "Name the chief engineer of the RMS Carpathia and his birth year, in one sentence."),
]


def capture(question, max_tokens=90):
    body = {
        "messages": [{"role": "user", "content": question}],
        "stream": True,
        "logprobs": True,
        "top_logprobs": 5,
        "max_tokens": max_tokens,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    req = urllib.request.Request(
        BASE + "/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    tokens = []
    with urllib.request.urlopen(req, timeout=120) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "ignore").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                ch = json.loads(data)
            except json.JSONDecodeError:
                continue
            for c in ch.get("choices", []):
                lp = c.get("logprobs")
                text = (c.get("delta") or {}).get("content")
                if not lp or not lp.get("content"):
                    continue
                for item in lp["content"]:
                    surp = -item["logprob"]
                    tops = item.get("top_logprobs", [])
                    ps = [math.exp(t["logprob"]) for t in tops]
                    H = -sum(p * math.log(p + 1e-12) for p in ps if p > 0)
                    margin = (tops[0]["logprob"] - tops[1]["logprob"]) if len(tops) > 1 else 0.0
                    tokens.append({
                        "token": item.get("token", text or ""),
                        "surprisal": round(surp, 4),
                        "entropy": round(H, 4),
                        "margin": round(margin, 4),
                    })
    answer = "".join(t["token"] for t in tokens)
    return answer.strip(), tokens


def main():
    out = {"prompts": []}
    for label, q in PROMPTS:
        answer, tokens = capture(q)
        out["prompts"].append({"label": label, "question": q, "answer": answer, "tokens": tokens})
        peak = max((t["surprisal"] for t in tokens), default=0)
        print(f"[{label}] {len(tokens)} tokens, peak surprisal {peak:.2f} :: {answer[:80]}")
    path = r"C:\Bonsai\tools\tree_data.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("wrote", path)


if __name__ == "__main__":
    main()
