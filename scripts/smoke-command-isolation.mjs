// Optional real-OS smoke test. No provider calls or external network requests.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { WorkspaceManager } from '../dist/workspace/manager.js';
import { CommandRuntime } from '../dist/command/runtime.js';
import { CommandPolicy } from '../dist/command/policy.js';

const root = await mkdtemp(path.join(process.cwd(), '.easy-code-isolation-smoke-'));
let safelyCleaned = false;
let accepted = 0;
const server = createServer(socket => { accepted++; socket.destroy(); });
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const project = path.join(root, 'workspace'); await mkdir(project);
  await writeFile(path.join(project, 'probe.cjs'), `
const fs=require('fs'),net=require('net');
const expectedReadonly=process.argv[2]==='plan';
let wrote=false;try{fs.writeFileSync('write-probe.txt','fixture');wrote=true}catch{}
if(wrote===expectedReadonly){console.error('filesystem boundary mismatch');process.exit(5)}
const s=net.connect({host:'127.0.0.1',port:${port}});
s.once('connect',()=>{console.error('network escaped');s.destroy();process.exitCode=6});
s.once('error',()=>{console.log('network blocked')});s.setTimeout(1500,()=>{s.destroy();console.log('network blocked (timeout)')});
`);
  const workspace = await WorkspaceManager.create(project);
  const context = { workspaceRoot: workspace.root, mode: 'code', threadId: 'smoke', turnId: 'smoke', approvalPolicy: 'safe', commandExecutionMode: 'auto_approve', requestApproval: async()=>true, commandTimeoutMs: 30000, maxOutputChars: 4000 };
  // Deliberately force one inspection classification in the trusted harness to
  // prove that the OS Plan fence survives a classifier defect.
  class ProbePolicy extends CommandPolicy { classify(input,command,mode) { return mode==='plan' ? { id:'smoke',effect:'allow',capability:'safe_inspect',risk:'read',reason:'trusted smoke probe',matchedRule:'smoke' } : super.classify(input,command,mode); } }
  const runtime = new CommandRuntime(workspace,new ProbePolicy(),undefined,undefined,{quarantinePath:path.join(root,'quarantine.json'),lifecycleDirectory:path.join(root,'leases')});
  for(const mode of ['code','plan']) {
    const result = await runtime.run({program:'node',args:['probe.cjs',mode],intent:mode==='plan'?'inspect':'run'},{...context,mode});
    console.log(JSON.stringify({mode,status:result.status,exitCode:result.exitCode,lifecycle:result.lifecycle,stderr:result.stderr.text}));
    if(process.platform==='win32'&&mode==='plan') {
      assert.equal(result.status,'sandbox_unavailable');assert.equal(result.failure?.processStarted,false);
      assert.match(result.stderr.text,/file-tools-only/);
    } else {
      assert.equal(result.status,'exited');assert.equal(result.exitCode,0);assert.equal(result.lifecycle?.cleanup,'confirmed');
    }
  }
  assert.equal(accepted,0,'sandbox connected to the host listener');
  safelyCleaned=true;
  console.log('Real OS smoke passed: offline Code with confirmed cleanup; Plan is read-only (Windows command refusal, Linux filesystem fence).');
} finally {
  server.close();
  if(safelyCleaned)await rm(root,{recursive:true,force:true});
  else console.error(`Smoke did not verify clean completion; retained exact diagnostic directory: ${root}`);
}
