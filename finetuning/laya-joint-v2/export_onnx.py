"""Export a full or merged-LoRA Laya model as a standalone CPU FP32 ONNX graph."""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "resources/laya-decision"))
from runtime import INPUTS, build_sequence, pack_inputs, file_hash

def export_agent(agent, folder: Path, source: Path, metadata=None):
    import torch
    fastpath = torch.backends.mha.get_fastpath_enabled()
    attention_classes = [(layer.self_attn, type(layer.self_attn)) for layer in agent.model.head.layers]
    try:
        return _export_agent(agent, folder, Path(source), metadata)
    finally:
        torch.backends.mha.set_fastpath_enabled(fastpath)
        for attention, original in attention_classes:
            attention.__class__ = original


def _export_agent(agent, folder: Path, source: Path, metadata=None):
    import torch
    folder = Path(folder)
    if (folder / "model.onnx").exists():
        raise FileExistsError(folder / "model.onnx")
    folder.mkdir(parents=True, exist_ok=True)
    agent.model.cpu().float().eval()
    questions = json.loads((ROOT / "resources/laya-decision/questions.json").read_text(encoding="utf-8"))
    work = []
    sequences = []
    for task, question in questions.items():
        for text in ("Inspect the workspace and explain the findings.", "检查代码并解释结果。 " * 1500):
            sequence = build_sequence(agent.tok, text, question, agent.cfg["max_len"], agent.cfg["head_max_len"])
            sequences.append(sequence)
            inputs = pack_inputs([sequence], agent.tok.pad_token_id)
            work.append({"inputs": {key: value.tolist() for key, value in inputs.items()}})
    work.append({"inputs": {key: value.tolist() for key, value in
                            pack_inputs([sequences[0], sequences[-1]], agent.tok.pad_token_id).items()}})
    # Disable the fused PyTorch head path for portable ONNX operators.
    torch.backends.mha.set_fastpath_enabled(False)

    class ExportAttention(torch.nn.MultiheadAttention):
        """Equivalent self attention with explicitly dynamic sequence reshapes.

        The legacy exporter freezes nn.MultiheadAttention's sequence length.
        Only the export copy is adapted; checkpoint parameters stay unchanged.
        """
        def forward(self, query, key, value, key_padding_mask=None, need_weights=False,
                    attn_mask=None, average_attn_weights=True, is_causal=False):
            import torch.nn.functional as F
            batch, length, width = query.shape
            q, k, v = F.linear(query, self.in_proj_weight, self.in_proj_bias).chunk(3, dim=-1)
            q, k, v = [part.reshape(batch, length, self.num_heads, self.head_dim).transpose(1, 2)
                       for part in (q, k, v)]
            mask = key_padding_mask[:, None, None, :] if key_padding_mask is not None else None
            if attn_mask is not None:
                mask = attn_mask if mask is None else mask + attn_mask
            result = F.scaled_dot_product_attention(q, k, v, attn_mask=mask, dropout_p=0., is_causal=is_causal)
            result = result.transpose(1, 2).reshape(batch, length, width)
            return self.out_proj(result), None

    samples = [{k: torch.tensor(row["inputs"][k], dtype=torch.bool if k == "marker_mask" else torch.long)
                for k in INPUTS} for row in work]
    with torch.inference_mode():
        reference = [agent.model(**sample) for sample in samples]
        for layer in agent.model.head.layers:
            layer.self_attn.__class__ = ExportAttention
        for sample, expected in zip(samples, reference, strict=True):
            for actual, wanted in zip(agent.model(**sample), expected, strict=True):
                torch.testing.assert_close(actual, wanted, rtol=1e-4, atol=1e-4)

    class FullDecisionGraph(torch.nn.Module):
        def __init__(self, model):
            super().__init__()
            self.model = model

        def forward(self, input_ids, attention_mask, marker_pos, marker_mask, qtype):
            return self.model(input_ids, attention_mask, marker_pos, marker_mask, qtype)

    sample = {k: torch.tensor(work[0]["inputs"][k],
                              dtype=torch.bool if k == "marker_mask" else torch.long)
              for k in INPUTS}
    dynamic = {"input_ids": {0: "batch", 1: "sequence"},
               "attention_mask": {0: "batch", 1: "sequence"},
               "marker_pos": {0: "batch", 1: "choices"},
               "marker_mask": {0: "batch", 1: "choices"}, "qtype": {0: "batch"},
               "logits": {0: "batch", 1: "choices"}, "act_logits": {0: "batch"}}
    # PyTorch SDPA returns zero for an entirely masked query row. The legacy
    # ONNX lowering's Softmax instead yields NaN, which contaminates padded
    # batches. Preserve SDPA's safe-softmax semantics in this export only.
    from torch.onnx import symbolic_opset14

    def safe_sdpa(graph, *values, **kwargs):
        value = symbolic_opset14.scaled_dot_product_attention(graph, *values, **kwargs)
        return graph.op("Where", graph.op("IsNaN", value),
                        graph.op("Constant", value_t=torch.tensor(0., dtype=torch.float32)), value)

    torch.onnx.register_custom_op_symbolic("aten::scaled_dot_product_attention", safe_sdpa, 20)
    try:
        with torch.inference_mode():
            torch.onnx.export(FullDecisionGraph(agent.model).eval(), tuple(sample.values()),
                              str(folder / "model.onnx"), input_names=list(INPUTS),
                              output_names=["logits", "act_logits"], dynamic_axes=dynamic,
                              opset_version=20, dynamo=False)
    finally:
        torch.onnx.unregister_custom_op_symbolic("aten::scaled_dot_product_attention", 20)

    # Do not publish a manifest for a graph that fails dynamic/batched parity.
    import numpy as np
    import onnx
    import onnxruntime as ort
    onnx.checker.check_model(str(folder / "model.onnx"))
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(folder / "model.onnx"), sess_options=options,
                                   providers=["CPUExecutionProvider"])
    for inputs, expected in zip(samples, reference, strict=True):
        actual = session.run(["logits", "act_logits"], {key: value.numpy() for key, value in inputs.items()})
        for found, wanted in zip(actual, expected, strict=True):
            np.testing.assert_allclose(found, wanted.numpy(), atol=1e-4, rtol=1e-4)
    del session

    for name in ("tokenizer", "encoder"):
        if (source / name).is_dir():
            shutil.copytree(source / name, folder / name, dirs_exist_ok=True)
    shutil.copy2(source / "rl_agent_config.json", folder / "rl_agent_config.json")
    files = ("model.onnx", "rl_agent_config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json")
    manifest = {"format": "easy-code-laya-onnx-v1", "precision": "fp32", "opset": 20,
                "source_sha256": file_hash(source / "model.safetensors") if (source / "model.safetensors").exists() else None,
                "files": {name: file_hash(folder / name) for name in files},
                "training": metadata or {}}
    (folder / "onnx_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    if metadata:
        (folder / "training_metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return manifest

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    import laya
    import torch
    torch.set_num_threads(4)
    agent = laya.load(str(args.checkpoint.resolve()), device="cpu")
    metadata = args.checkpoint / "training_metadata.json"
    print(json.dumps(export_agent(agent, args.output, args.checkpoint,
                                 json.loads(metadata.read_text(encoding="utf-8")) if metadata.exists() else {})))
