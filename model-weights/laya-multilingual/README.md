# Shared Laya model weights

`base/` contains the original [laya-multilingual](https://huggingface.co/convaiinnovations/laya-multilingual) model. `finetuned/` contains the EASY CODE V10 full-parameter fine-tuned checkpoint derived from it. Each directory includes its own configuration and tokenizer.

These are the single repository copies used by both `finetuning/laya-multilingual/` and `jev-benchmark/`. The `.safetensors` weights and tokenizer files use Git LFS. See the [fine-tuning README](../../finetuning/laya-multilingual/README.md) for method and data provenance, and the [benchmark README](../../jev-benchmark/README.md) for evaluation results.
