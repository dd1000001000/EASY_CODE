# Final joint Laya checkpoint

`model/` is the single retained trained checkpoint for the joint route and
pre-delivery experiment. It starts from `../upstream-base/` and was trained
with full-parameter supervised fine-tuning (SFT) on two labeled choice tasks.
The `.safetensors` and tokenizer files are tracked with Git LFS. The upstream
Laya multilingual model card lists the Apache-2.0 license.

Training data, code, provenance, per-class accuracies, and confusion matrices:
[`../../../finetuning/laya-joint-v2/README.md`](../../../finetuning/laya-joint-v2/README.md).
The full per-case evaluation is in `report.json`.

This checkpoint is experimental and is **not yet connected to EASY CODE
Runtime**. In particular, its delivery errors make it unsuitable as a sole
automatic approval mechanism.
