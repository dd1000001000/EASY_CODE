"""Line-oriented, tool-free local inference for EASY CODE's two Laya decisions."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from runtime import OnnxAgent, build_sequence, pack_inputs, probabilities

ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / "model-weights/laya-multilingual/joint-v2/model"
QUESTIONS = json.loads((Path(__file__).parent / "questions.json").read_text(encoding="utf-8"))
MAX_SOURCE_CHARS = 100_000
OMISSION = "\n[... middle omitted for local decision ...]\n"


def emit(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")), flush=True)


def trim_chars(text: str) -> tuple[str, bool]:
    if len(text) <= MAX_SOURCE_CHARS:
        return text, False
    room = MAX_SOURCE_CHARS - len(OMISSION)
    head = (room + 1) // 2
    return text[:head] + OMISSION + text[-(room - head):], True


def trim_to_model(agent, raw: str, question: dict) -> tuple[str, int, bool]:
    text, clipped = trim_chars(raw)
    tokenizer = agent.tok
    empty, markers = build_sequence(tokenizer, "", question,
                                    max_len=agent.cfg["max_len"],
                                    head_max_len=agent.cfg["head_max_len"])
    if len(markers) != len(question["crit"]):
        raise ValueError("The decision options exceed the model header budget")
    room = agent.cfg["max_len"] - len(empty)
    if room < 8:
        raise ValueError("The decision header leaves no room for input")
    token_ids = tokenizer(text.replace(tokenizer.mask_token, " "),
                          add_special_tokens=False)["input_ids"]
    if len(token_ids) <= room:
        return text, len(token_ids), clipped

    marker_ids = tokenizer(OMISSION, add_special_tokens=False)["input_ids"]
    available = room - len(marker_ids)
    if available < 2:
        raise ValueError("The model input budget cannot retain both ends")
    # Decode and re-tokenize the candidate: token-piece boundaries can change
    # when the two retained portions become adjacent to the omission marker.
    while available >= 2:
        head = (available + 1) // 2
        candidate = (tokenizer.decode(token_ids[:head], skip_special_tokens=False)
                     + OMISSION
                     + tokenizer.decode(token_ids[-(available - head):], skip_special_tokens=False))
        actual = tokenizer(candidate.replace(tokenizer.mask_token, " "),
                           add_special_tokens=False)["input_ids"]
        if len(actual) <= room:
            return candidate, len(actual), True
        available -= max(1, len(actual) - room)
    raise ValueError("Could not fit both ends within the model input budget")


def decide(agent, request: dict) -> dict:
    task = request.get("task")
    raw = request.get("input")
    if task not in QUESTIONS or not isinstance(raw, str) or not raw.strip():
        raise ValueError("Expected a nonempty input and a route or delivery task")
    if len(raw) > 2_000_000:
        raise ValueError("Decision input exceeds the transport limit")
    question = QUESTIONS[task]
    text, input_tokens, truncated = trim_to_model(agent, raw, question)
    options = list(question["crit"])
    ids, markers = build_sequence(agent.tok, text, question,
                                  max_len=agent.cfg["max_len"],
                                  head_max_len=agent.cfg["head_max_len"])
    if len(markers) != len(options):
        raise ValueError("Decision options were truncated")
    logits, _ = agent.infer(pack_inputs([(ids, markers)], agent.tok.pad_token_id))
    scores = probabilities(logits[0, :len(options)]).tolist()
    winner = max(range(len(options)), key=lambda index: scores[index])
    return {"task": task, "input": text, "inputTokens": input_tokens,
            "truncated": truncated, "optionOrder": options,
            "scores": dict(zip(options, scores)), "decision": options[winner]}


def main() -> None:
    agent = OnnxAgent(MODEL)
    emit({"type": "ready", "modelSha256": agent.model_sha256, "device": agent.device,
          "backend": "onnx-fp32"})
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("Request must be an object")
            result = decide(agent, request)
            emit({"type": "result", "id": request.get("id"), **result})
        except Exception as error:
            emit({"type": "error", "id": request.get("id") if isinstance(request, dict) else None,
                  "error": str(error)[:500]})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Laya worker startup failed: {error}", file=sys.stderr, flush=True)
        raise
