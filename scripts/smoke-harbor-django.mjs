// No model/API calls. Run against a disposable SWE-bench Django image, with
// this repository mounted read-only at /source and the helper compiled first.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceManager } from '../dist/workspace/manager.js';
import { CommandRuntime } from '../dist/command/runtime.js';
import { HarborSandboxBackend, inspectHarborSandbox } from '../dist/sandbox/harbor-backend.js';

process.env.EASY_CODE_OUTER_SANDBOX = 'harbor';
console.log(await inspectHarborSandbox());
const privateRoot = await mkdtemp('/tmp/easy-code-django-smoke-');
const workspace = await WorkspaceManager.create('/testbed');
const backend = new HarborSandboxBackend(workspace, ['/source', privateRoot]);
const runtime = new CommandRuntime(workspace, undefined, backend, undefined, { networkProfile: 'benchmark',
  quarantinePath: path.join(privateRoot, 'quarantine.json'), lifecycleDirectory: path.join(privateRoot, 'leases') });
const context = { workspaceRoot: '/testbed', mode: 'code', threadId: 'django-smoke', turnId: 'smoke',
  approvalPolicy: 'safe', commandExecutionMode: 'auto_approve', requestApproval: async () => true,
  commandTimeoutMs: 120000, maxOutputChars: 16000 };
try {
  const result = await runtime.run({ program: '/opt/miniconda3/envs/testbed/bin/python3.6',
    args: ['tests/runtests.py', 'migrations.test_writer', '-v', '1'], intent: 'test', verificationKind: 'unit_test',
    timeoutMs: 120000 }, context);
  console.log(JSON.stringify({ status: result.status, exitCode: result.exitCode, lifecycle: result.lifecycle,
    stdout: result.stdout.text, stderr: result.stderr.text }));
  assert.equal(result.status, 'exited');
  assert.equal(result.exitCode, 0);
  assert.equal(result.lifecycle?.cleanup, 'confirmed');
  assert.match(result.stderr.text, /Ran \d+ tests/);
  console.log('Original Django migrations.test_writer completed with its default parallelism.');
} finally {
  await runtime.cancelAll();
  await rm(privateRoot, { recursive: true, force: true });
}
