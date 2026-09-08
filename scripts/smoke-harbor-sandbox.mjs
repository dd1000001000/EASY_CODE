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
  await run('local IPC and asyncio thread wakeup', `
import socket, asyncio, threading, os
for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM, socket.SOCK_SEQPACKET):
    a,b=socket.socketpair(socket.AF_UNIX,kind | socket.SOCK_CLOEXEC | socket.SOCK_NONBLOCK)
    assert not a.get_inheritable() and not b.get_inheritable()
    a.sendall(b'ping'); assert b.recv(4)==b'ping'
    b.send(b'pong'); assert a.recv(4)==b'pong'
    os.write(a.fileno(), b'pipe'); assert os.read(b.fileno(),4)==b'pipe'
    try: a.sendto(b'x', '/tmp/forbidden-destination')
    except PermissionError: pass
    else: raise AssertionError('sendto with destination allowed')
    try: a.sendmsg([b'x'])
    except PermissionError: pass
    else: raise AssertionError('ancillary message syscall allowed')
    a.close(); b.close()
for family,kind,proto in ((socket.AF_INET,socket.SOCK_STREAM,0),(socket.AF_UNIX,socket.SOCK_RAW,0),(socket.AF_UNIX,socket.SOCK_STREAM,1)):
    try: socket.socketpair(family,kind,proto)
    except PermissionError: pass
    else: raise AssertionError('non-local or unsupported pair allowed')
async def main():
    loop=asyncio.get_running_loop(); done=loop.create_future()
    thread=threading.Thread(target=lambda: loop.call_soon_threadsafe(done.set_result,'awake'))
    thread.start(); assert await asyncio.wait_for(done,2)=='awake'; thread.join()
asyncio.run(main())
print('anonymous IPC and asyncio wakeup OK')
`);
  await run('Django setup and focused unittest', `
import django, unittest, enum
from django.conf import settings
settings.configure(SECRET_KEY='smoke',INSTALLED_APPS=[],DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}},USE_I18N=False)
django.setup()
from django.test import SimpleTestCase
from django.utils.http import parse_http_date
from django.db.migrations.serializer import serializer_factory
class Sample(enum.Enum): VALUE='value'
class Smoke(SimpleTestCase):
    def test_http(self): self.assertEqual(parse_http_date('Sun, 06 Nov 1994 08:49:37 GMT'),784111777)
    def test_enum(self): self.assertIn('Sample',serializer_factory(Sample.VALUE).serialize()[0])
result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Smoke))
assert result.testsRun==2 and result.wasSuccessful()
`);
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
  // The trusted fixture builder, never the agent, prepares repository metadata.
  execFileSync('git', ['-C', project, 'add', 'ok.txt']);
  execFileSync('git', ['-C', project, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'baseline']);
  await writeFile(path.join(project, 'ok.txt'), 'changed\n');
  const gitRun = async args => {
    const r = await runtime.run({ program: 'git', args, intent: 'inspect' }, context);
    assert.equal(r.status, 'exited'); assert.equal(r.exitCode, 0); assert.equal(r.lifecycle?.cleanup, 'confirmed');
    return r;
  };
  assert.match((await gitRun(['diff', '--', 'ok.txt'])).stdout.text, /\+changed/);
  await run('indirect Git via Python and shell', `
import os, subprocess
assert 'GIT_EXTERNAL_DIFF' not in os.environ
for args in (['git','diff','--','ok.txt'], ['/bin/sh','-c','git diff -- ok.txt']):
    assert '+changed' in subprocess.check_output(args,text=True)
print('Python and shell inherited Git environment OK')
`);
  for (const [key,value] of [['diff.external',''],['diff.external','false'],['diff.hostile.command','false'],['diff.hostile.textconv','false']]) {
    execFileSync('git',['-C',project,'config',key,value]);
    await writeFile(path.join(project,'.gitattributes'),'*.txt diff=hostile\n');
    assert.match((await gitRun(['diff','--','ok.txt'])).stdout.text,/\+changed/);
  }
  execFileSync('git',['-C',project,'add','ok.txt']);
  assert.match((await gitRun(['diff','--cached','--','ok.txt'])).stdout.text,/\+changed/);
  assert.match((await gitRun(['show','HEAD','--','ok.txt'])).stdout.text,/\+ok/);
  assert.match((await gitRun(['log','-p','-1','--','ok.txt'])).stdout.text,/\+ok/);
  console.log('Git diff/show/log, staged changes and hostile helper configuration passed.');
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
  assert.equal(await readFile(path.join(project, 'ok.txt'), 'utf8'), 'changed\n');
  console.log('Harbor real Runtime smoke passed: offline even in dangerous mode, Plan read-only, detached/timeout/cancel cleanup confirmed.');
  completed = true;
} finally {
  await runtime.cancelAll();
  if (completed) await rm(root, { recursive: true, force: true });
  else console.error(`Preserved smoke evidence: ${root}`);
}
