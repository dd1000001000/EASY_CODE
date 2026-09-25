# Final joint Laya checkpoint

`model/` is the retained trained checkpoint for the joint route and
pre-delivery experiment. It was trained from the upstream Laya multilingual
checkpoint with full-parameter supervised fine-tuning (SFT) on two labeled
choice tasks. The original weights are not provided here: see the
[training and evaluation guide](../../../finetuning/laya-joint-v2/README.md)
for the upstream GitHub and Hugging Face links, a pinned download command,
and instructions to run the held-out test without the original weights.
The `.safetensors` and tokenizer files are tracked with Git LFS. The upstream
Laya multilingual model card lists the Apache-2.0 license.

Training data, code, provenance, accuracies, and confusion matrices:
[`../../../finetuning/laya-joint-v2/README.md`](../../../finetuning/laya-joint-v2/README.md).
The full per-case evaluation is in `report.json`.

This checkpoint is experimental and is **not yet connected to EASY CODE
Runtime**. In particular, its delivery errors make it unsuitable as a sole
automatic approval mechanism.
