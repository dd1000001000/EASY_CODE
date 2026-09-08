import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../src/core/types.js";
import {
  CreateFileTool,
  CompactContextTool,
  DeleteFileTool,
  ReadFileTool,
  ReadImageTool,
  UpdateFileTool,
  createDefaultTools,
} from "../src/tools/index.js";
import {
  WorkspaceManager,
  captureWorkspaceSnapshot,
} from "../src/workspace/index.js";
import { getEasyCodeHome } from "../src/prompt-bundle/index.js";
import { WorkspacePathGuard } from "../src/workspace/path-guard.js";
import { describe, it } from "./harness.js";

async function withWorkspace(run: (root: string, manager: WorkspaceManager) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-tools-"));
  try {
    const manager = await WorkspaceManager.create(root);
    await run(root, manager);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function context(
  root: string,
  mode: ToolContext["mode"] = "code",
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    workspaceRoot: root,
    mode,
    threadId: "thread-test",
    turnId: "turn-test",
    approvalPolicy: "safe",
    requestApproval: async () => false,
    commandTimeoutMs: 2_000,
    maxOutputChars: 4_096,
    ...overrides,
  };
}

function compactContextV2Input() {
  return {
    formatVersion: 2,
    primaryRequest: {
      sourceMessageIndex: 8,
      text: "Continue the authentication fix.",
    },
    activeConstraints: [{
      sourceMessageIndex: 9,
      text: "  Do not change the public API.  ",
    }],
    technicalDecisions: [{
      decision: "Keep authorization at the Runtime boundary.",
      evidenceRefIds: ["file-runtime"],
    }],
    filesAndChanges: [{
      path: "src/runtime/agent.ts",
      status: "read",
      summary: "Runtime owns capability enforcement.",
      evidenceRefIds: ["file-runtime"],
    }],
    verifiedResults: [{
      result: "The focused authorization test passed.",
      evidenceRefIds: ["test-auth"],
    }],
    errorsAndBlockers: [],
    pendingWork: ["Implement the remaining validation."],
    currentWork: "Designing Compaction Summary V2.",
    nextStep: "Patch the compact_context tool schema.",
    evidenceRefs: [
      { id: "file-runtime", kind: "file", reference: "src/runtime/agent.ts" },
      { id: "test-auth", kind: "test", reference: "authorization focused test" },
    ],
    intentLedger: {
      userCorrections: [{
        sourceMessageIndex: 9,
        text: "Do not change the public API.",
      }],
      supersededRequests: [{
        sourceMessageIndex: 3,
        text: "Use the earlier draft schema.",
      }],
    },
    coverageCheck: {
      coveredMessageIndices: [3, 8, 9],
      latestMessageIndex: 9,
      latestRequestPreserved: true,
      activeConstraintsPreserved: true,
      activePlanOrTaskPreserved: true,
      unresolvedErrorsPreserved: true,
      currentWorkPreserved: true,
      nextStepPreserved: true,
      note: "Primary request, correction, and current work are covered.",
    },
  };
}

describe("workspace file tools", () => {
  it("keeps the fixed official Prompt Bundle outside ordinary workspace tools", () => {
    const home = path.dirname(getEasyCodeHome());
    const guard = new WorkspacePathGuard(home);
    const relative = path.relative(home, path.join(getEasyCodeHome(), "active.json"));
    assert.throws(
      () => guard.normalizeRelative(relative),
      /official EASY CODE Runtime resources/iu,
    );
  });
  it("exports the workspace tools and runtime context tool", async () => {
    await withWorkspace(async (_root, manager) => {
      assert.deepEqual(
        createDefaultTools(manager).map((tool) => tool.name),
        [
          "read_file",
          "search_files",
          "read_image",
          "create_file",
          "update_file",
          "delete_file",
          "run_command",
          "start_command",
          "poll_command",
          "cancel_command",
          "manage_tasks",
          "propose_plan",
          "compact_context",
        ],
      );
    });
  });

  it("loads a workspace image through the runtime attachment boundary", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(path.join(root, "diagram.png"), Buffer.from("image bytes"));
      const tool = new ReadImageTool(manager);
      let attachedPath = "";
      const result = await tool.execute(
        { path: "diagram.png" },
        {
          ...context(root, "plan"),
          attachImage: async ({ absolutePath }) => {
            attachedPath = absolutePath;
            return {
              id: "image_00000000-0000-4000-8000-000000000000",
              label: "Image #1",
              mediaType: "image/png",
              storageKey:
                "attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-000000000000.png",
              sha256: "0".repeat(64),
              byteSize: 11,
              width: 1,
              height: 1,
            };
          },
        },
      );

      assert.equal(result.ok, true);
      assert.equal(attachedPath, path.join(manager.root, "diagram.png"));
      assert.equal(result.imageAttachments?.[0]?.label, "Image #1");
      assert.equal(
        Object.prototype.hasOwnProperty.call(result.data as object, "storageKey"),
        false,
      );
    });
  });

  it("accepts a semantic handoff without delegating Runtime facts or committing context", async () => {
    const tool = new CompactContextTool();
    const input = { currentWork: "Communication investigation unfinished", nextStep: "Trace the receiver", hypotheses: ["A local bridge may be involved"] };
    const accepted = await tool.execute(
      input,
      context(process.cwd()),
    );
    const rejected = await tool.execute(
      { summary: "", extra: true },
      context(process.cwd()),
    );

    assert.equal(tool.mutating, false);
    assert.equal(accepted.ok, true);
    const persisted = JSON.parse(accepted.contextCompaction?.summary ?? "{}") as {
      formatVersion?: number;
      activeConstraints?: Array<{ sourceMessageIndex: number; text: string }>;
      coverageCheck?: unknown;
      intentLedger?: unknown;
    };
    assert.deepEqual(persisted, input);
    assert.equal(persisted.coverageCheck, undefined);
    assert.equal(persisted.intentLedger, undefined);
    assert.equal(accepted.contextCompaction?.intentLedger, undefined);
    assert.equal(accepted.contextCompaction?.coverageCheck, undefined);
    assert.equal(accepted.contextCompaction?.formatVersion, 3);
    assert.deepEqual(accepted.data, { formatVersion: 3 });
    assert.match(accepted.summary, /Runtime has not committed/);
    const modelVisibleResult = JSON.stringify({
      summary: accepted.summary,
      data: accepted.data,
    });
    assert.doesNotMatch(modelVisibleResult, /coveredMessageIndices|userCorrections/u);
    assert.equal(rejected.ok, false);
  });

  it("publishes one small provider-neutral semantic schema without self-certification flags", () => {
    const parameters = new CompactContextTool().definition.function.parameters;
    const serialized = JSON.stringify(parameters);
    const root = parameters as {
      additionalProperties?: boolean;
      required?: string[];
      properties?: Record<string, unknown>;
    };

    assert.equal(root.additionalProperties, false);
    assert.equal(root.properties?.coverageCheck, undefined);
    assert.equal(root.properties?.intentLedger, undefined);
    assert.ok(root.properties?.currentWork);
    assert.ok(root.properties?.nextStep);
    assert.equal(root.properties?.summary, undefined);
    assert.equal(root.properties?.analysis, undefined);
    assert.doesNotMatch(serialized, /"(?:oneOf|anyOf|allOf)"/u);
    assert.doesNotMatch(serialized, /<\/?[A-Za-z]/u);
  });

  it("rejects malformed V2 coverage and exact-source fields", async () => {
    const tool = new CompactContextTool();
    const unsorted = compactContextV2Input();
    unsorted.coverageCheck.coveredMessageIndices = [8, 3, 9];
    const whitespaceConstraint = compactContextV2Input();
    whitespaceConstraint.activeConstraints[0]!.text = "   ";
    const extraField = {
      ...compactContextV2Input(),
      analysis: "unbounded private reasoning",
    };

    for (const invalid of [
      { summary: "legacy model-facing input is no longer accepted" },
      unsorted,
      whitespaceConstraint,
      extraField,
    ]) {
      const result = await tool.execute(invalid, context(process.cwd()));
      assert.equal(result.ok, false);
      assert.equal(result.contextCompaction, undefined);
    }
  });

  it("reads a line range and tracks the full-file SHA-256 version", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(path.join(root, "sample.txt"), "one\r\ntwo\r\nthree\r\n", "utf8");
      const tool = new ReadFileTool(manager);
      const result = await tool.execute(
        { path: "sample.txt", startLine: 2, endLine: 3 },
        context(root),
      );

      assert.equal(result.ok, true);
      const data = result.data as {
        content: string;
        contentHash: string;
        newline: string;
        startLine: number;
        endLine: number;
      };
      assert.equal(data.content, "two\nthree");
      assert.equal(data.newline, "crlf");
      assert.equal(data.startLine, 2);
      assert.equal(data.endLine, 3);
      assert.match(data.contentHash, /^[a-f0-9]{64}$/u);
      assert.equal(manager.getReadVersion("sample.txt")?.hash, data.contentHash);
    });
  });

  it("creates nested files but never overwrites an existing target", async () => {
    await withWorkspace(async (root, manager) => {
      const tool = new CreateFileTool(manager);
      const first = await tool.execute({ path: "src/new.ts", content: "export {};\n" }, context(root));
      const second = await tool.execute({ path: "src/new.ts", content: "overwritten" }, context(root));

      assert.equal(first.ok, true);
      assert.equal(second.ok, false);
      assert.deepEqual(first.presentation, {
        type: "file_diff",
        operation: "create",
        path: "src/new.ts",
        before: "",
        after: "export {};\n",
      });
      assert.equal(second.presentation, undefined);
      assert.equal(await readFile(path.join(root, "src", "new.ts"), "utf8"), "export {};\n");
      assert.equal(manager.getChangeSet().filter((change) => change.operation === "create").length, 1);
    });
  });

  it("updates only the verified file-tool target in the live manifest", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(path.join(root, "external-change.txt"), "outside the tool\n", "utf8");
      const created = await new CreateFileTool(manager).execute(
        { path: "created-by-tool.txt", content: "verified\n" },
        context(root),
      );

      assert.equal(created.ok, true);
      const manifest = manager.getManifestSnapshot();
      assert.equal(manifest?.files.has("created-by-tool.txt"), true);
      assert.equal(manifest?.files.has("external-change.txt"), false);

      const reconciled = await manager.fullConsistencyCheck();
      assert.deepEqual(reconciled.created.map((entry) => entry.path), ["external-change.txt"]);
    });
  });

  it("requires a matching read hash and applies unique exact edits atomically", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(path.join(root, "code.ts"), "const value = 1;\n", "utf8");
      const reader = new ReadFileTool(manager);
      const updater = new UpdateFileTool(manager);
      const read = await reader.execute({ path: "code.ts" }, context(root));
      const hash = (read.data as { contentHash: string }).contentHash;

      const updated = await updater.execute(
        {
          path: "code.ts",
          expectedHash: hash,
          edits: [{ oldText: "value = 1", newText: "value = 2" }],
        },
        context(root),
      );
      assert.equal(updated.ok, true);
      assert.deepEqual(updated.presentation, {
        type: "file_diff",
        operation: "update",
        path: "code.ts",
        before: "const value = 1;\n",
        after: "const value = 2;\n",
      });
      assert.equal(await readFile(path.join(root, "code.ts"), "utf8"), "const value = 2;\n");
      assert.notEqual((updated.data as { contentHash: string }).contentHash, hash);
      assert.equal(manager.getChangeSet().at(-1)?.status, "verified");
    });
  });

  it("detects concurrent edits and refuses ambiguous replacements", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(path.join(root, "code.ts"), "same same\n", "utf8");
      const reader = new ReadFileTool(manager);
      const updater = new UpdateFileTool(manager);
      const read = await reader.execute({ path: "code.ts" }, context(root));
      const hash = (read.data as { contentHash: string }).contentHash;

      const ambiguous = await updater.execute(
        {
          path: "code.ts",
          expectedHash: hash,
          edits: [{ oldText: "same", newText: "changed" }],
        },
        context(root),
      );
      assert.equal(ambiguous.ok, false);
      assert.equal(ambiguous.presentation, undefined);

      await writeFile(path.join(root, "code.ts"), "user changed this\n", "utf8");
      const conflict = await updater.execute(
        {
          path: "code.ts",
          expectedHash: hash,
          edits: [{ oldText: "same same", newText: "changed" }],
        },
        context(root),
      );
      assert.equal(conflict.ok, false);
      assert.equal(conflict.presentation, undefined);
      assert.match(conflict.error ?? "", /changed after it was read/iu);
      assert.equal(await readFile(path.join(root, "code.ts"), "utf8"), "user changed this\n");
      assert.equal(manager.getChangeSet().at(-1)?.status, "conflict");
    });
  });

  it("treats Plan editing as a preference while retaining path boundaries in both modes", async () => {
    await withWorkspace(async (root, manager) => {
      const create = new CreateFileTool(manager);
      const planResult = await create.execute({ path: "plan-note.txt", content: "note" }, context(root, "plan"));
      assert.equal(planResult.ok, true);
      assert.equal(await readFile(path.join(root, "plan-note.txt"), "utf8"), "note");
      for (const mode of ["plan", "code"] as const) {
        const traversal = await create.execute({ path: "../escape.txt", content: "no" }, context(root, mode));
        assert.equal(traversal.ok, false);
      }
    });
  });

  it("rejects absolute host reads and writes in every approval posture", async () => {
    const hostRoot = await mkdtemp(path.join(os.tmpdir(), "easy-code-host-files-"));
    try {
      const target = path.join(hostRoot, "outside.txt");
      await writeFile(target, "user content");
      await withWorkspace(async (root, manager) => {
        for (const commandExecutionMode of ["manual", "auto_approve", "unrestricted"] as const) {
          const ctx = context(root, "code", { commandExecutionMode, isUnrestrictedHostAccessActive: () => true });
          assert.equal((await new ReadFileTool(manager).execute({ path: target }, ctx)).ok, false);
          assert.equal((await new CreateFileTool(manager).execute({ path: path.join(hostRoot, "new.txt"), content: "no" }, ctx)).ok, false);
          assert.equal((await new UpdateFileTool(manager).execute({ path: target, expectedHash: "0".repeat(64), edits: [{ oldText: "user", newText: "model" }] }, ctx)).ok, false);
          assert.equal((await new DeleteFileTool(manager).execute({ path: target, expectedHash: "0".repeat(64) }, ctx)).ok, false);
        }
        assert.equal(await readFile(target, "utf8"), "user content");
        assert.equal(manager.getChangeSet().some(change => path.isAbsolute(change.path)), false);
      });
    } finally { await rm(hostRoot, { recursive: true, force: true }); }
  });

  it("does not return host content when dangerous access is revoked during a read", async () => {
    const hostRoot = await mkdtemp(path.join(os.tmpdir(), "easy-code-host-read-revoke-"));
    try {
      const target = path.join(hostRoot, "secret.txt");
      await writeFile(target, "host content", "utf8");
      await withWorkspace(async (root, manager) => {
        let checks = 0;
        const result = await new ReadFileTool(manager).execute(
          { path: target },
          context(root, "code", {
            commandExecutionMode: "unrestricted",
            isUnrestrictedHostAccessActive: () => {
              checks += 1;
              return checks === 1;
            },
          }),
        );
        assert.equal(result.ok, false);
        assert.match(result.error ?? "", /Absolute paths/iu);
        assert.doesNotMatch(JSON.stringify(result), /host content/u);
      });
    } finally {
      await rm(hostRoot, { recursive: true, force: true });
    }
  });

  it("rejects Git control files and nested .git paths case-insensitively", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(path.join(root, ".git"), "gitdir: ../runtime-owned\n", "utf8");
      const read = new ReadFileTool(manager);
      const create = new CreateFileTool(manager);
      const update = new UpdateFileTool(manager);
      const remove = new DeleteFileTool(manager);

      const results = await Promise.all([
        read.execute({ path: ".git" }, context(root)),
        read.execute({ path: ".GIT" }, context(root)),
        create.execute(
          { path: "nested/.GiT/config", content: "[core]\n" },
          context(root),
        ),
        update.execute(
          {
            path: "nested/.gIt/config",
            expectedHash: "0".repeat(64),
            edits: [{ oldText: "a", newText: "b" }],
          },
          context(root),
        ),
        remove.execute(
          { path: "nested/.GIT/config", expectedHash: "0".repeat(64) },
          context(root),
        ),
      ]);

      for (const result of results) {
        assert.equal(result.ok, false);
        assert.match(result.error ?? "", /Git control paths are reserved/iu);
      }
      assert.equal(await readFile(path.join(root, ".git"), "utf8"), "gitdir: ../runtime-owned\n");
    });
  });

  it("ignores a linked-worktree-shaped .git control file in snapshots", async () => {
    await withWorkspace(async (root, manager) => {
      await writeFile(path.join(root, ".git"), "gitdir: ../.git/worktrees/child\n", "utf8");
      await writeFile(path.join(root, "visible.txt"), "workspace content\n", "utf8");

      const snapshot = await captureWorkspaceSnapshot(manager.pathGuard);

      assert.equal(snapshot.truncated, false);
      assert.equal(snapshot.files.has(".git"), false);
      assert.deepEqual([...snapshot.files.keys()], ["visible.txt"]);
    });
  });

  it("always hides Runtime sandbox scratch data from file tools and snapshots", async () => {
    await withWorkspace(async (root, manager) => {
      const scratch = path.join(root, ".easy-code-srt-runtime", "command-fixture");
      await mkdir(scratch, { recursive: true });
      await writeFile(path.join(scratch, "worker-payload.json"), "secret argv", "utf8");
      await writeFile(path.join(root, "visible.txt"), "workspace content\n", "utf8");

      const snapshot = await captureWorkspaceSnapshot(manager.pathGuard, {
        ignoredDirectoryNames: new Set<string>(),
      });
      assert.deepEqual([...snapshot.files.keys()], ["visible.txt"]);

      const result = await new ReadFileTool(manager).execute(
        { path: ".easy-code-srt-runtime/command-fixture/worker-payload.json" },
        context(root),
      );
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /Sandbox scratch paths are reserved/iu);
      const dotted = await new ReadFileTool(manager).execute(
        { path: "./.easy-code-srt-runtime/command-fixture/worker-payload.json" },
        context(root),
      );
      assert.equal(dotted.ok, false);
      assert.match(dotted.error ?? "", /Sandbox scratch paths are reserved/iu);
    });
  });

  it("rejects a directory symlink or junction that escapes the workspace", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "easy-code-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "outside", "utf8");
      await withWorkspace(async (root, manager) => {
        const link = path.join(root, "escape");
        await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
        const reader = new ReadFileTool(manager);
        const result = await reader.execute({ path: "escape/secret.txt" }, context(root));
        assert.equal(result.ok, false);
        assert.match(result.error ?? "", /workspace boundary/iu);
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
