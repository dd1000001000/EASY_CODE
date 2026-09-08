// Run INSIDE a disposable, non-privileged Docker container after compiling
// scripts/harbor-sandbox.c to /opt/easy-code-harbor/harbor-sandbox. No model API.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { execa } from 'execa';
import { WorkspaceManager } from '../dist/workspace/manager.js';
import { CommandRuntime } from '../dist/command/runtime.js';
import { HarborSandboxBackend, inspectHarborSandbox } from '../dist/sandbox/harbor-backend.js';

process.env.EASY_CODE_OUTER_SANDBOX = 'harbor';
console.log(await inspectHarborSandbox());
const root = await mkdtemp('/tmp/easy-code-harbor-smoke-');
const project = path.join(root, 'workspace');
await mkdir(project);
execFileSync('git', ['init', '-q', project]);
const secret = path.join(root, 'secret.txt'); await writeFile(secret, 'not-for-the-model');
const workspace = await WorkspaceManager.create(project);
const backend = new HarborSandboxBackend(workspace, [secret, '/source']);
const runtime = new CommandRuntime(workspace, undefined, backend, undefined, { networkProfile: 'benchmark',
  quarantinePath: path.join(root, 'quarantine.json'), lifecycleDirectory: path.join(root, 'leases') });
const context = { workspaceRoot: workspace.root, mode: 'code', threadId: 'harbor-smoke', turnId: 'smoke', approvalPolicy: 'safe',
  commandExecutionMode: 'auto_approve', requestApproval: async () => true, commandTimeoutMs: 15000, maxOutputChars: 8000 };
const run = async (label, code, overrides = {}) => {
  const result = await runtime.run({ program: '/usr/bin/python3', args: ['-c', code], intent: 'run' }, { ...context, ...overrides });
  console.log(JSON.stringify({ label, status: result.status, exitCode: result.exitCode, lifecycle: result.lifecycle,
    stdout: result.stdout.text, stderr: result.stderr.text }));
  assert.equal(result.status, 'exited'); assert.equal(result.exitCode, 0);
  assert.equal(result.lifecycle?.cleanup, 'confirmed');
  return result;
};
let completed = false;
try {
  await run('multiline writes and reads', "from pathlib import Path\nPath('ok.txt').write_text('ok')\nassert Path('ok.txt').read_text() == 'ok'");
  const probes = `
import socket, os, errno
from pathlib import Path
for family, kind in [(socket.AF_INET,socket.SOCK_STREAM),(socket.AF_INET,socket.SOCK_DGRAM),(socket.AF_INET6,socket.SOCK_STREAM),(socket.AF_UNIX,socket.SOCK_STREAM)]:
    try: socket.socket(family,kind)
    except PermissionError: pass
    else: raise AssertionError('network socket allowed')
for target in [${JSON.stringify(secret)}, '/proc/self/environ', '/proc/1/mem', '/source/package.json']:
    try: Path(target).read_bytes()
    except PermissionError: pass
    else: raise AssertionError('sensitive read allowed: '+target)
for target in ['/etc/harbor-escape', '.git/config']:
    try: Path(target).write_text('bad')
    except PermissionError: pass
    else: raise AssertionError('protected write allowed: '+target)
try: os.kill(os.getppid(), 0)
except PermissionError: pass
else: raise AssertionError('supervisor signal allowed')
print('network, sensitive reads, protected writes and supervisor signals denied')
`;
  await run('kernel denials, automatic mode', probes);
  await run('kernel denials, dangerous mode', probes, { commandExecutionMode: 'unrestricted' });
  const planCode = `from pathlib import Path
assert Path('ok.txt').read_text() == 'ok'
try: Path('ok.txt').write_text('changed')
except PermissionError: pass
else: raise AssertionError('Plan wrote workspace')
`;
  const planRejected = await runtime.run({ program: '/usr/bin/python3', args: ['-c', planCode], intent: 'run' }, { ...context, mode: 'plan' });
  assert.equal(planRejected.status, 'policy_denied');
  // Even an accidentally permissive classifier must not bypass kernel read-only.
  const planPrepared = await backend.prepare({ commandId: 'plan_probe', context: { ...context, mode: 'plan' },
    command: { executablePath: '/usr/bin/python3', args: ['-c', planCode], cwdAbsolute: project, environment: {} }, policyDecision: {}, commandPreview: 'Plan kernel probe' });
  const planProcess = execa(planPrepared.executablePath, planPrepared.args, { env: planPrepared.environment, extendEnv: false,
    cwd: planPrepared.cwdAbsolute, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  planProcess.stdio[3].resume();
  assert.equal((await planProcess).exitCode, 0); await planPrepared.cleanup();
  console.log('Plan policy and kernel read-only probes passed.');
  const git = await runtime.run({ program: 'git', args: ['status', '--porcelain'], intent: 'inspect' }, context);
  assert.equal(git.status, 'exited'); assert.equal(git.exitCode, 0); assert.equal(git.lifecycle?.cleanup, 'confirmed');
  // A setsid/double-fork child must be killed even after its immediate parent exits.
  const detached = await run('detached grandchild cleanup', `import os,time
if os.fork() == 0:
    os.setsid()
    if os.fork() == 0:
        print('PID='+str(os.getpid()),flush=True)
        time.sleep(60)
    os._exit(0)
time.sleep(.2)
`);
  const pid = Number(detached.stdout.text.match(/PID=(\d+)/)?.[1]); assert.ok(pid > 1);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  const linger = "import os,time\nif os.fork()==0:\n os.setsid()\n print('PID='+str(os.getpid()),flush=True)\ntime.sleep(60)";
  const timed = await runtime.run({ program: '/usr/bin/python3', args: ['-c', linger], intent: 'run', timeoutMs: 300 }, context);
  assert.equal(timed.status, 'timed_out'); assert.equal(timed.lifecycle?.cleanup, 'confirmed');
  const timedPid = Number(timed.stdout.text.match(/PID=(\d+)/)?.[1]); assert.ok(timedPid > 1);
  assert.throws(() => process.kill(timedPid, 0), /ESRCH/);
  let pending = await runtime.start({ program: '/usr/bin/python3', args: ['-c', linger], intent: 'run' }, context);
  for (let n = 0; n < 20 && pending.status === 'running' && !pending.stdout.text.includes('PID='); n++)
    pending = await runtime.status(pending.commandId, context, 100);
  assert.equal(pending.status, 'running');
  const canceledPid = Number(pending.stdout.text.match(/PID=(\d+)/)?.[1]); assert.ok(canceledPid > 1);
  const canceled = await runtime.cancel(pending.commandId, context);
  assert.equal(canceled.status, 'canceled'); assert.equal(canceled.lifecycle?.cleanup, 'confirmed');
  assert.throws(() => process.kill(canceledPid, 0), /ESRCH/);
  assert.equal(await readFile(path.join(project, 'ok.txt'), 'utf8'), 'ok');
  console.log('Harbor real Runtime smoke passed: offline even in dangerous mode, Plan read-only, detached/timeout/cancel cleanup confirmed.');
  completed = true;
} finally {
  await runtime.cancelAll();
  if (completed) await rm(root, { recursive: true, force: true });
  else console.error(`Preserved smoke evidence: ${root}`);
}
