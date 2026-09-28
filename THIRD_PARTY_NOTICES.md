# Third-Party Notices

EASY CODE's original source code is licensed under the MIT License in
[`LICENSE`](./LICENSE). Third-party components retain their own licenses.

## OpenAI Codex CLI runtime

EASY CODE declares `@openai/codex@latest` and uses the version resolved when the
user installs EASY CODE. Its platform-native binary is used only as a
model-free command-sandbox service. The dependency and matching optional
platform package are installed through the npm dependency tree.

- Project: [OpenAI Codex](https://github.com/openai/codex)
- License: [Apache License 2.0](https://github.com/openai/codex/blob/main/LICENSE)

Other npm dependencies are governed by the license metadata and license files
distributed with their respective packages.

## Laya local decision model and choice encoding

The bundled joint-v2 model is a full-parameter fine-tune of
[Convai Innovations Laya multilingual](https://huggingface.co/convaiinnovations/laya-multilingual),
exported to FP32 ONNX. The choice sequence builder in
`resources/laya-decision/runtime.py` adapts the choice-only path of Laya 0.3.20's
`common.build_sequence`; training and export also use Laya.

- Author: Convai Innovations
- License: Apache License 2.0; included at
  [`resources/laya-decision/LICENSE-LAYA`](resources/laya-decision/LICENSE-LAYA)
- Changes: standalone NumPy/Rust-tokenizer encoding, choice-only validation,
  ONNX inference, and EASY CODE's joint routing/delivery fine-tune.

ONNX Runtime and Hugging Face tokenizers are installed from their official Python
packages; their MIT and Apache-2.0 licenses respectively remain in those packages.
