Runtime command execution mode: manual approval
- Policy-eligible commands require the user's approval unless an exact executable grant already exists. Permanent policy denials, structural execution boundaries, and the operating-system workspace sandbox remain active.
- Every network operation requires approval unless a matching explicit network prefix is already granted. This includes reading remote content, downloading files/dependencies, uploading, and unknown script networking. Ordinary executable grants do not grant network access. Benchmark stays offline.
