"""CPU ONNX inference and choice encoding, without PyTorch or Transformers.

Choice encoding follows Laya 0.3.20 (Apache-2.0); see THIRD_PARTY_NOTICES.md.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from tokenizers import Tokenizer

INPUTS = ("input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype")


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class ChoiceTokenizer:
    def __init__(self, folder: Path):
        self.backend = Tokenizer.from_file(str(folder / "tokenizer.json"))
        self.backend.no_padding()
        self.backend.no_truncation()
        config = json.loads((folder / "tokenizer_config.json").read_text(encoding="utf-8"))
        for name in ("mask", "cls", "sep", "pad"):
            token = config[f"{name}_token"]
            if isinstance(token, dict):
                token = token["content"]
            token_id = self.backend.token_to_id(token)
            if token_id is None:
                raise ValueError(f"Missing {name} token")
            setattr(self, f"{name}_token", token)
            setattr(self, f"{name}_token_id", token_id)

    def __call__(self, text, add_special_tokens=False, truncation=False, max_length=None):
        ids = self.backend.encode(text, add_special_tokens=add_special_tokens).ids
        return {"input_ids": ids[:max_length] if truncation else ids}

    def decode(self, ids, skip_special_tokens=False):
        return self.backend.decode(ids, skip_special_tokens=skip_special_tokens)


def build_sequence(tok, state: str, question: dict, max_len=1024, head_max_len=256, option_order=None):
    if question["t"] != "choice":
        raise ValueError("This runtime supports choice tasks only")
    options = [key if value is None or value == "" else f"{key}: {value}"
               for key, value in question["crit"].items()]
    order = list(range(len(options))) if option_order is None else list(option_order)
    if sorted(order) != list(range(len(options))) or len(options) < 2:
        raise ValueError("Expected a permutation of at least two choices")
    clean = lambda value: value.replace(tok.mask_token, " ")
    head = tok(f"choice question: {clean(str(question['ins']))}", add_special_tokens=False)["input_ids"]
    choices = [[tok.mask_token_id] + tok(" " + clean(options[index]), add_special_tokens=False, truncation=True,
                                        max_length=48)["input_ids"] for index in order]
    budget = head_max_len - sum(map(len, choices))
    if budget < 16:
        per = max(4, (head_max_len - 16) // len(choices))
        choices = [choice[:per] for choice in choices]
        budget = head_max_len - sum(map(len, choices))
    ids = [tok.cls_token_id] + head[:max(8, budget)] + [tok.sep_token_id]
    markers = []
    for choice in choices:
        markers.append(len(ids))
        ids.extend(choice)
    ids.append(tok.sep_token_id)
    room = max(0, max_len - len(ids) - 1)
    ids += tok(clean(state), add_special_tokens=False)["input_ids"][:room] + [tok.sep_token_id]
    return ids[:max_len], [marker for marker in markers if marker < max_len]


def pack_inputs(sequences, pad_token_id):
    size, length = len(sequences), max(len(ids) for ids, _ in sequences)
    choices = max(len(markers) for _, markers in sequences)
    ids = np.full((size, length), pad_token_id, dtype=np.int64)
    attention = np.zeros_like(ids)
    markers = np.zeros((size, choices), dtype=np.int64)
    valid = np.zeros_like(markers, dtype=np.bool_)
    for index, (tokens, positions) in enumerate(sequences):
        ids[index, :len(tokens)] = tokens
        attention[index, :len(tokens)] = 1
        markers[index, :len(positions)] = positions
        valid[index, :len(positions)] = True
    return dict(zip(INPUTS, (ids, attention, markers, valid, np.zeros(size, dtype=np.int64)), strict=True))


def probabilities(logits):
    values = np.asarray(logits, dtype=np.float64)
    if not np.isfinite(values).all():
        raise ValueError("Nonfinite local decision scores")
    values = np.exp(values - values.max(axis=-1, keepdims=True))
    return values / values.sum(axis=-1, keepdims=True)


class OnnxAgent:
    def __init__(self, folder: Path, threads=4):
        import onnxruntime as ort

        folder = Path(folder)
        manifest = json.loads((folder / "onnx_manifest.json").read_text(encoding="utf-8"))
        if manifest["format"] != "easy-code-laya-onnx-v1":
            raise ValueError("Unsupported ONNX checkpoint format")
        for name in ("model.onnx", "rl_agent_config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"):
            if file_hash(folder / name) != manifest["files"][name]:
                raise ValueError(f"ONNX checkpoint hash mismatch: {name}")
        self.model_sha256 = manifest["files"]["model.onnx"]
        self.cfg = json.loads((folder / "rl_agent_config.json").read_text(encoding="utf-8"))
        self.tok = ChoiceTokenizer(folder / "tokenizer")
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        self.session = ort.InferenceSession(str(folder / "model.onnx"), sess_options=options,
                                           providers=["CPUExecutionProvider"])
        if {value.name for value in self.session.get_inputs()} != set(INPUTS):
            raise ValueError("Unexpected ONNX decision input schema")
        self.device = "cpu"

    def infer(self, inputs):
        return self.session.run(["logits", "act_logits"], inputs)
