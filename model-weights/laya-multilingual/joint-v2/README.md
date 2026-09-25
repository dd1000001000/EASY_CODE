# Final fine-tuned Laya checkpoint

`model/` is the retained fine-tuned Laya (joint-v2) checkpoint for the joint route and
pre-delivery experiment. It was trained from the upstream Laya multilingual
checkpoint with full-parameter supervised fine-tuning (SFT) on two labeled
choice tasks. The [training and evaluation guide](../../../finetuning/laya-joint-v2/README.md)
provides the upstream GitHub and Hugging Face links, a pinned download command,
and instructions to run the held-out test using the bundled checkpoint.
The `.safetensors` and tokenizer files are tracked with Git LFS. The upstream
Laya multilingual model card lists the Apache-2.0 license.

Fine-tuned Laya training data, code, provenance, accuracies, and confusion matrices (with separately labeled pre-fine-tuning baseline results):
[`../../../finetuning/laya-joint-v2/README.md`](../../../finetuning/laya-joint-v2/README.md).
The full per-case evaluation is in `report.json`.

EASY CODE uses this checkpoint for local Auto routing and a one-time
pre-delivery reminder. Runtime completion checks and independent review
continue to apply. The delivery classifier compares the user request with
the main agent's own summary. If local inference fails, Auto routing uses
the existing cloud controller; Code delivery reports the issue and proceeds
through the existing completion checks.
