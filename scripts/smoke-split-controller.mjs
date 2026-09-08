import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { WorkspaceManager } from '../dist/workspace/manager.js';
import { CommandRuntime } from '../dist/command/runtime.js';
import { BenchmarkContainerBackend } from '../dist/sandbox/benchmark-backend.js';

await writeFile('/tmp/easy-code-controller-only', 'private runtime secret');
const workspace = await WorkspaceManager.create('/testbed');
const runtime = new CommandRuntime(workspace, undefined, new BenchmarkContainerBackend(), undefined, { networkProfile: 'benchmark' });
const context = { workspaceRoot: '/testbed', mode: 'plan', threadId: 'split-smoke', turnId: 'split-turn',
  commandExecutionMode: 'unrestricted', approvalPolicy: 'never', requestApproval: async () => { throw Error('Benchmark asked for approval'); },
  commandTimeoutMs: 120000, maxOutputChars: 16000 };
const code = `import os, socket, multiprocessing as mp
assert not os.path.exists('/tmp/easy-code-controller-only')
assert not os.path.exists('/opt/easy-code-command-bridge/binding.json')
assert not os.path.exists('/source/package.json')
with open('/etc/easy-code-worker-only', 'w') as f: f.write('container root write')
with open('/tmp/worker-only-script', 'w') as f: f.write('#!/bin/sh\\necho worker-only-executable\\n')
os.chmod('/tmp/worker-only-script', 0o755)
with open('/testbed/split-smoke-marker.txt', 'w') as f: f.write('worker patch')
lock = mp.Lock()
value = mp.Value('i', 0)
with lock: value.value += 1
with mp.Pool(12) as pool: assert pool.map(abs, [-1, -2]) == [1, 2]
s = socket.socket()
s.settimeout(1)
try:
 s.connect(('203.0.113.1', 443))
 raise AssertionError('network escaped')
except OSError: pass
finally: s.close()
print('container root writes, private IPC and 12-process pool passed; external network denied')
`;
const result = await runtime.run({ program: '/opt/miniconda3/envs/testbed/bin/python3.6', args: ['-c', code], intent: 'test', executionScope: 'host' }, context);
console.log(JSON.stringify(result, null, 2));
assert.equal(result.status, 'exited'); assert.equal(result.exitCode, 0); assert.equal(result.lifecycle.cleanup, 'confirmed');
const workerOnly = await runtime.run({ program: '/tmp/worker-only-script', cwd: '/tmp', intent: 'run' }, context);
assert.equal(workerOnly.exitCode, 0, JSON.stringify(workerOnly)); assert.match(workerOnly.stdout.text, /worker-only-executable/);
const isolatedGit = await runtime.run({ program: 'git', args: ['config', '--local', 'easycode.workerOnly', 'yes'], intent: 'run' }, context);
assert.equal(isolatedGit.exitCode, 0);
const { execFileSync } = await import('node:child_process');
assert.doesNotMatch(execFileSync('git', ['config', '--local', '--list'], { cwd: '/testbed' }).toString(), /easycode.workeronly/);
const detached = await runtime.run({ program: 'sh', args: ['-c', "(sleep 3; echo escaped > /testbed/detached-survived.txt) >/dev/null 2>&1 & echo launched"], intent: 'run' }, context);
assert.equal(detached.exitCode, 0);
const cleaned = await runtime.run({ program: 'sh', args: ['-c', 'sleep 4; test ! -e /testbed/detached-survived.txt'], intent: 'run' }, context);
assert.equal(cleaned.exitCode, 0, 'Detached descendant survived Docker cleanup');
const timeout = await runtime.run({ program: 'sh', args: ['-c', 'sleep 30'], intent: 'run', timeoutMs: 300 }, context);
assert.equal(timeout.status, 'timed_out', JSON.stringify(timeout)); assert.equal(timeout.lifecycle.cleanup, 'confirmed');
const django = await runtime.run({ program: '/opt/miniconda3/envs/testbed/bin/python3.6', args: ['tests/runtests.py', 'migrations.test_writer', '-v', '1'], intent: 'test' }, context);
console.log(JSON.stringify(django, null, 2));
assert.equal(django.exitCode, 0); assert.match(django.stderr.text, /Ran 46 tests/);
console.log('Plan commands and explicit host requests stayed container-confined; Django 46 tests passed.');
