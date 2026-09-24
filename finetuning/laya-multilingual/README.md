# Fine-tuning Laya Multilingual for EASY CODE decisions (V10)

This folder contains a three-task experiment starting from the original [laya-multilingual](https://huggingface.co/convaiinnovations/laya-multilingual) weights. The shared repository directory `../../model-weights/laya-multilingual/` holds the only copies used by both this training code and `jev-benchmark`: `base/` is the original model and `finetuned/` is the full-parameter supervised checkpoint. Both include the weights, configuration, encoder configuration, and tokenizer needed for inference. This model has **not** been integrated into EASY CODE's production decision path.

## Data provenance and task inputs

GPT-6 Luna subagents generated candidate examples for earlier dataset iterations. Those examples were inspected, corrected, and filtered across subsequent revisions. V10 carries forward earlier examples and labels, rewrites their inputs to better resemble EASY CODE Runtime requests, and adds contrast cases authored, labeled, and reviewed by the main agent. The latter are recorded in `data_runtime_v10/teacher_audit.jsonl`. Therefore, not every V10 row is an unchanged Luna output, and inherited labels were not all recertified in this round. The original per-example Luna generation transcripts are not retained here, so this folder cannot independently replay that generation process.

The frozen `data_runtime_v10/` snapshot contains 1,578 training, 177 validation, and 126 test examples. `manifest.json` records hashes, class counts, and provenance notes. Test examples were not used for checkpoint selection.

| Task | Input | Labels |
|---|---|---|
| Routing | User-message body sent to the Auto controller | `DIRECT`, `PLAN`, `CODE` |
| Command-approval prefilter | Runtime-shaped JSON approval packet, including the user task, command, working directory, and proposed permission prefix | `AUTO_ALLOW`, `NEED_REVIEW` |
| Pre-delivery check | Original user request plus the main agent's completion summary | `RELEASE`, `CHALLENGE` |

Commands in the dataset are inert text; neither generation nor evaluation executes them. `NEED_REVIEW` means defer to the independent approval flow, not permanently deny execution. The delivery task represents a proposed interface, not a deployed product feature. `teacher_cases_v10.py`, `materialize_approval_v10.mjs`, and the audit file remain here because snapshot verification checks them; the retired V9 dataset is not needed to train from the frozen V10 snapshot.

## Fine-tuning method

`train_binary_joint.py` jointly fine-tunes all model parameters on the three supervised choice tasks. This is **not** LoRA and does not train the model to generate explanations: it scores candidate labels. Each epoch shuffles examples, and each example gets a shuffled answer order. Safe/risky approval contrasts stay paired; an additional ranking loss encourages the safe command's auto-allow score to exceed the risky command's. The `NEED_REVIEW` class receives extra loss weight. Training uses BF16, gradient checkpointing, and CUDA.

The saved run used seed 42, at most three epochs, effective batch size 16, encoder learning rate `3e-6`, scoring-head learning rate `1.5e-5`, pairwise-loss weight `0.2`, and review-class weight `1.5`. Validation selected the checkpoint by minimizing risky auto-allow in **any** option order, then maximizing stable safe-command allowance, then routing-plus-delivery accuracy. Epoch 2 was selected. Full parameters and history are in `../../model-weights/laya-multilingual/finetuned/training_metadata.json`.

`evaluate_binary_joint.py` tests every option order and records per-case probabilities. On the frozen test set, the fine-tuned model got 163/204 routing, 88/136 approval, and 33/48 delivery option orders correct. It auto-allowed 11 of 34 risky commands in at least one order. Its scores are not calibrated and **must not be used alone for production command approval**. The GLM comparison is in `../../jev-benchmark/`.

## Run

Use Python with `laya==0.3.10`, a CUDA-enabled PyTorch build, and an NVIDIA GPU. Large model files are tracked through Git LFS. From this directory, no `F:\models` paths are needed:

```powershell
python v10_snapshot.py
python evaluate_binary_joint.py --split test --output .\test-recheck.json
```

To train again, choose a **new, nonexistent** output directory. Training loads `../../model-weights/laya-multilingual/base/` by default:

```powershell
python train_binary_joint.py --output .\runs\trial-01 --epochs 3 --encoder-learning-rate 3e-6 --head-learning-rate 1.5e-5 --pair-weight 0.2 --selection-policy safety_first
```

Training will not overwrite the shared `finetuned/` checkpoint. Reports and new trial directories are generated artifacts; decide whether to keep them before committing.
