// Read-only historical contract replay. Never resolves/spawns commands, contacts
// providers, changes jobs, or treats container paths as host executable paths.
import { readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { runCommandInputSchema, pollCommandInputSchema, cancelCommandInputSchema } from '../dist/tools/run-command.js';
import { validateCommandRequest } from '../dist/command/request-validation.js';
import { CommandPolicy } from '../dist/command/policy.js';

const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw new Error('Usage: node scripts/replay-command-requests.mjs <absolute-job-directory>');
const files = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(filename);
    else if (entry.name === 'events.jsonl') files.push(filename);
  }
}
await visit(root);
const report = { journals: files.length, commandCalls: 0, launches: 0, handles: 0, acceptedShape: 0,
  normalizedMetadata: 0, rejectionCounts: {}, policyDryRun: {}, note: 'Shape/policy replay only; no spawn, executable resolution, path/sandbox proof, or network access.' };
const increment = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
for (const filename of files) {
  const seen = new Set();
  const lines = createInterface({ input: createReadStream(filename), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type !== 'tool.call') continue;
    const call = event.payload;
    const name = call?.function?.name;
    if (!['run_command', 'start_command', 'poll_command', 'cancel_command'].includes(name)) continue;
    if (seen.has(call.id)) continue; seen.add(call.id);
    report.commandCalls++;
    const launch = ['run_command', 'start_command'].includes(name);
    if (launch) report.launches++; else report.handles++;
    let raw;
    try { raw = JSON.parse(call.function.arguments); } catch { increment(report.rejectionCounts, 'invalid_json'); continue; }
    const parsed = (launch ? runCommandInputSchema : name === 'poll_command' ? pollCommandInputSchema : cancelCommandInputSchema).safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) increment(report.rejectionCounts, `parameter.${issue.path.join('.') || 'input'}`);
      continue;
    }
    const failure = launch ? validateCommandRequest(parsed.data) : undefined;
    if (failure) { increment(report.rejectionCounts, failure.matchedRule); continue; }
    report.acceptedShape++;
    if (!launch) continue;
    const input = parsed.data;
    if (input.normalizationWarnings?.length) report.normalizedMetadata++;
    // Deliberately withhold trusted-executable exemptions in an offline replay.
    const decision = new CommandPolicy().classify(input, { program: input.program, executablePath: input.program,
      args: input.args ?? [], cwdAbsolute: '/testbed', cwdRelative: '.', executableInsideWorkspace: false,
      trustedExecutable: false, environment: {}, environmentKeys: [] }, 'code', false);
    increment(report.policyDryRun, `${decision.effect}:${decision.matchedRule}`);
  }
}
console.log(JSON.stringify(report, null, 2));
