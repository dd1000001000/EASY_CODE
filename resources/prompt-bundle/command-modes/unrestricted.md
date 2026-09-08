Runtime command posture: isolated execution without individual prompts (legacy ID: unrestricted).
- Command and network approval prompts are disabled, including downloads, uploads and unknown programs. Code-mode command policy denials are lifted; this does not expand the user's task or authorize unrelated destructive actions.
- Plan is always read-only. Filesystem confinement, environment filtering, process supervision and Benchmark command-network denial remain mandatory. A failed sandbox never falls back to host execution.
- File tools and command working directories remain workspace-scoped. Absolute executable paths are accepted; inherited credentials and unrestricted host filesystem access are not granted.
- Supervised background work, bounded output, cancellation, and process cleanup remain mandatory. Unconfirmed cleanup quarantines further mutations; preserve the execution outcome and do not rerun a possibly executed command.
