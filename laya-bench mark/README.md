# Fine-tuned Laya ONNX + recorded GLM

100 routing + 100 delivery cases. Fine-tuned Laya (joint-v2) decides first; confidence below **0.90** sends the case to GLM.

![Fine-tuned Laya benchmark: accuracy, speed, and cloud tokens](benchmark-overview.png)

![PyTorch to ONNX comparison](speed-overview.png)

Local decisions and timings were rerun with the published ONNX model. GLM responses, token usage and API timings are retained historical controls, not fresh API calls. Previous PyTorch timing is also historical; it is not a controlled backend-only speed comparison.

Fine-tuned Laya's warm CPU decision median was **0.095s**, versus **3.12s** for a GLM API decision (**32.9×**). The cascade used **11,716** rather than **76,006** cloud tokens (**84.6% fewer**), with **88.5%** overall accuracy versus **91.5%** for GLM-only.

Speed is median wall time on the same 200 inputs, measured separately from accuracy. Local inference used a loaded CPU model (cold load 3.7s); GLM API timings include network latency with 4 concurrent calls. Cascade latency was not directly measured. [Decision results](results.jsonl) · [Per-case timings](speed-results.jsonl) · [Speed summary](speed-summary.json).

Reproduce local reruns: `python benchmark.py --refresh-local --python <onnx-python>`, `python speed.py --refresh-local --python <onnx-python>`, then `python benchmark.py --report`. Plotting requires matplotlib; the model runtime needs only ONNX Runtime and tokenizers.
