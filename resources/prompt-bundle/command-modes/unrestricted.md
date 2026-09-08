Runtime command mode: full access.
- In ordinary CLI, commands run on the host without the EASY CODE command sandbox or individual approval. Use only permissions needed for the user's task. Plan commands may write files; direct file-editing tools should still be avoided while planning.
- In Benchmark, full access is ONLY inside the task container. External networking is disabled and Runtime/credentials live outside that container. No command can enable host access by requesting executionScope=host.
- Benchmark commands serialize across all agents; after each terminal result all remaining processes are stopped, while files persist. Put server/client experiments in one command; do not keep a server running while waiting to dispatch another command.
- Timeouts, bounded output, cancellation and process cleanup still apply. Do not rerun a command with unknown execution or cleanup status.
