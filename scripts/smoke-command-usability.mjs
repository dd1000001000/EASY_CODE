// Real OS smoke for the relaxed command contract. No provider/public network.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceManager } from '../dist/workspace/manager.js';
import { CommandRuntime } from '../dist/command/runtime.js';
import { captureValidationBaseline } from '../dist/progress/validation-standard.js';

const root = await mkdtemp(path.join(process.cwd(), '.easy-code-usability-smoke-'));
let cleaned = false;
let runtime;
try {
  const project = path.join(root, 'workspace'); await mkdir(project);
  await mkdir(path.join(project, 'tests'));
  await writeFile(path.join(project, 'tests', 'failing.test.cjs'), "const test=require('node:test'); const assert=require('node:assert/strict');test('boundary',()=>assert.equal(2,3));\n");
  const workspace = await WorkspaceManager.create(project);
  runtime = new CommandRuntime(workspace, undefined, undefined, undefined, { networkProfile: 'benchmark',
    quarantinePath: path.join(root, 'quarantine.json'), lifecycleDirectory: path.join(root, 'leases') });
  const context = { workspaceRoot: workspace.root, mode: 'code', threadId: 'usability-smoke', turnId: 'smoke', approvalPolicy: 'safe',
    commandExecutionMode: 'auto_approve', requestApproval: async () => true, commandTimeoutMs: 15000, maxOutputChars: 512,
    validationBaseline: await captureValidationBaseline(project) };
  const run = async (label, request) => {
    const result = await runtime.run(request, context);
    console.log(JSON.stringify({ label, status: result.status, exitCode: result.exitCode, validation: result.validation?.status, lifecycle: result.lifecycle,
      ...(result.status !== 'exited' || result.exitCode !== 0 ? { stderr: result.stderr.text, stdout: result.stdout.text } : {}) }));
    assert.equal(result.status, 'exited'); assert.equal(result.lifecycle?.cleanup, 'confirmed');
    return result;
  };
  const inline = await run('multiline/absolute-cwd/literal-argv', { program: process.execPath,
    args: ['-e', "const fs=require('fs');\nfs.writeFileSync('inline.txt','ok');\nconsole.log(process.argv.slice(1).join(','));", '|', '&'], cwd: path.join(project, 'tests'), intent: 'run' });
  assert.equal(inline.exitCode, 0); assert.match(inline.stdout.text, /\|,&/);
  if (process.platform === 'win32') {
    await writeFile(path.join(project, 'tests', 'check.ps1'), "& node -e 'console.log(42)'\n");
    assert.equal((await run('powershell-file-and-call', { program: 'powershell', args: ['-File', 'check.ps1'], cwd: 'tests/../tests', intent: 'verify' })).exitCode, 0);
  } else {
    await writeFile(path.join(project, 'tests', 'check.sh'), "node <<'JS'\nconsole.log(42)\nJS\n");
    assert.equal((await run('shell-file-and-heredoc', { program: 'sh', args: ['check.sh'], cwd: 'tests/../tests', intent: 'verify' })).exitCode, 0);
  }
  const piped = await run('masked-test-exit', { program: process.platform === 'win32' ? 'cmd' : 'sh',
    args: process.platform === 'win32' ? ['/c', 'node --test --test-reporter=tap failing.test.cjs 2>&1 | findstr /r "^#"']
      : ['-c', "node --test --test-reporter=tap failing.test.cjs 2>&1 | grep '^#'"], cwd: 'tests', intent: 'verify' });
  assert.equal(piped.exitCode, 0); assert.equal(piped.validation?.status, 'failed');
  assert.equal(piped.validation?.standard?.status, 'unchanged');
  await writeFile(path.join(project, 'tests', 'failing.test.cjs'), "const test=require('node:test'); const assert=require('node:assert/strict');test('boundary',()=>assert.equal(2,2));\n");
  const weakened = await run('weakened-original-test', { program: 'node', args: ['--test', '--test-reporter=tap', 'failing.test.cjs'], cwd: 'tests', intent: 'verify' });
  assert.equal(weakened.validation?.status, 'passed');
  assert.equal(weakened.validation?.standard?.status, 'changed');
  await writeFile(path.join(project, 'linger.cjs'), "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore',windowsHide:true});console.log('child-started');setInterval(()=>{},100);\n");
  let running = await runtime.start({ program: 'node', args: ['linger.cjs'], intent: 'run' }, context);
  for (let attempt = 0; attempt < 30 && running.status === 'running' && !running.stdout.text.includes('child-started'); attempt++) {
    running = await runtime.status(running.commandId, context, 500);
  }
  assert.equal(running.status, 'running'); assert.match(running.stdout.text, /child-started/);
  const canceled = await runtime.cancel(running.commandId, context);
  assert.equal(canceled.status, 'canceled'); assert.equal(canceled.lifecycle?.cleanup, 'confirmed');
  const timed = await runtime.run({ program: 'node', args: ['linger.cjs'], intent: 'run', timeoutMs: 150 }, context);
  assert.equal(timed.status, 'timed_out'); assert.equal(timed.lifecycle?.cleanup, 'confirmed');
  console.log('Real OS usability smoke passed, including supervised child cancellation and timeout.');
  cleaned = true;
} finally {
  await runtime?.cancelAll();
  if (cleaned) await rm(root, { recursive: true, force: true });
  else console.error(`Retained exact diagnostic fixture: ${root}`);
}
