// Real-OS proxy-chain smoke. No public network, DNS lookup, provider API or secrets.
// Only this trusted test maps fixture.test to the local fixture server. Product
// Runtime never accepts this resolver override from configuration/model input.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { WorkspaceManager } from '../dist/workspace/manager.js';
import { CommandRuntime } from '../dist/command/runtime.js';
import { AnthropicSandboxBackend } from '../dist/sandbox/anthropic-backend.js';
import { createCommandNetworkGate } from '../dist/command/network-gate.js';

const root = await mkdtemp(path.join(process.cwd(), '.easy-code-network-smoke-'));
let clean = false, requests = 0, approvals = 0, decisions = 0;
let gate;
const server = createServer((_req, res) => { requests++; res.end('local-network-fixture-ok'); });
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const project = path.join(root, 'workspace'); await mkdir(project);
  const workspace = await WorkspaceManager.create(project);
  gate = await createCommandNetworkGate({ authorize: async () => { decisions++; return true; }, record: () => {}, resolveHost: async host => {
    assert.equal(host, 'fixture.test'); return '127.0.0.1';
  } });
  const native = new AnthropicSandboxBackend(workspace);
  const backend = { describe: req => native.describe(req), assertEnvironmentSafe: () => native.assertEnvironmentSafe(),
    quarantine: reason => native.quarantine(reason), prepare: req => native.prepare({ ...req, networkProxyURL: gate.proxyURL }) };
  const runtime = new CommandRuntime(workspace, undefined, backend, undefined, {
    quarantinePath: path.join(root, 'quarantine.json'), lifecycleDirectory: path.join(root, 'leases'),
  });
  const context = { workspaceRoot: workspace.root, mode: 'code', threadId: 'network-smoke', turnId: 'network-smoke',
    approvalPolicy: 'safe', commandExecutionMode: 'auto_approve', commandTimeoutMs: 15000, maxOutputChars: 2000,
    requestApproval: async () => { approvals++; return false; } };
  const input = { program: 'curl', args: ['-q', '--fail', '--max-time', '5', `http://fixture.test:${port}/`], intent: 'inspect' };
  for (const mode of ['manual', 'auto_approve', 'unrestricted']) {
    const before = requests;
    const result = await runtime.run(input, { ...context, commandExecutionMode: mode });
    console.log(JSON.stringify({ mode, status: result.status, exitCode: result.exitCode, lifecycle: result.lifecycle, stderr: result.stderr.text }));
    if (mode === 'manual') { assert.equal(result.status, 'policy_denied'); assert.equal(requests, before); }
    else {
      assert.equal(result.status, 'exited'); assert.equal(result.exitCode, 0);
      assert.match(result.stdout.text, /local-network-fixture-ok/); assert.equal(result.lifecycle?.cleanup, 'confirmed');
      assert.equal(requests, before + 1);
    }
  }
  assert.equal(approvals, 1); assert.equal(decisions, 2);
  clean = true;
  console.log('Real OS network smoke passed: manual denial; Auto read and dangerous no-prompt via SRT -> Runtime gate -> local fixture; confirmed cleanup.');
} finally {
  await gate?.close(); await new Promise(resolve => server.close(resolve));
  if (clean) await rm(root, { recursive: true, force: true });
  else console.error(`Retained exact smoke diagnostic directory: ${root}`);
}
