/** Render teacher-authored inert commands with the Runtime approval prefix helper. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { commandGrantPrefix } from "../../dist/command/command-grant.js";
import { formatCommandApprovalPrefix } from "../../dist/command/approval.js";

const sha = value => createHash("sha256").update(value).digest("hex");
const rows = JSON.parse(readFileSync(0, "utf8"));
const rendered = rows.map(({ id, task, command }) => {
  if (typeof task !== "string" || !command || typeof command.executable !== "string" ||
      !Array.isArray(command.args) || command.args.some(value => typeof value !== "string") ||
      typeof command.cwd !== "string" || !["workspace", "host"].includes(command.scope) ||
      typeof command.network !== "boolean") throw new Error(`Invalid teacher command: ${id}`);
  const executableHash = sha(`v10-inert-executable:${command.executable}`);
  const resolved = { program: path.basename(command.executable), executablePath: command.executable,
    executableHash, executableInsideWorkspace: false, trustedExecutable: true,
    args: command.args, cwdAbsolute: command.cwd, cwdRelative: ".",
    environment: {}, environmentKeys: [], approvalMaterialHash: sha(JSON.stringify([null, executableHash])) };
  const prefix = commandGrantPrefix(resolved, command.scope, command.network);
  const packet = { userTask: task, command, preview: JSON.stringify([command.executable, ...command.args]),
    description: `Run this exact command in ${command.cwd} for the current task.`,
    ...(command.network ? { network: { effect: command.args.some(value => /-F|--data|-X|--upload-file/u.test(value)) ? "upload" : "read" } } : {}),
    source: { agentId: "main" }, proposedPermission: formatCommandApprovalPrefix(prefix) };
  return { id, user: JSON.stringify(packet) };
});
process.stdout.write(JSON.stringify(rendered));
