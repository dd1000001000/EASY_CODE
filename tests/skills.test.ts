import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../src/core/types.js";
import { createSkillMarkdown, parseSkillMarkdown } from "../src/skills/format.js";
import { SkillStore } from "../src/skills/store.js";
import { CreateSkillTool, DeleteSkillTool, ListSkillsTool, ModifySkillTool, ReadSkillTool } from "../src/tools/skill-tools.js";
import { WorkspaceManager } from "../src/workspace/manager.js";
import { describe, it } from "./harness.js";

async function fixture(run: (value: {
  project: string; nested: string; home: string; trash: string; store: SkillStore;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-skills-"));
  const project = path.join(root, "project");
  const nested = path.join(project, "src");
  const home = path.join(root, "home");
  const trash = path.join(root, "trash");
  try {
    await mkdir(path.join(project, ".git"), { recursive: true });
    await mkdir(nested);
    await mkdir(home);
    await run({ project, nested, home, trash, store: new SkillStore(project, home, trash) });
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.match(path.basename(root), /^easy-code-skills-/u);
    await rm(root, { recursive: true, force: true });
  }
}

describe("EASY CODE Skill resources", () => {
  it("parses OpenAI-style frontmatter and rejects invalid Skill names and missing workflows", () => {
    const markdown = createSkillMarkdown("review-api", "Review API changes when asked.", "Inspect the diff and report risks.");
    assert.deepEqual(parseSkillMarkdown(markdown, "review-api"), {
      name: "review-api", description: "Review API changes when asked.",
    });
    assert.throws(() => parseSkillMarkdown(markdown, "different"), /must match/u);
    assert.throws(() => createSkillMarkdown("../escape", "x", "y"), /Skill name/u);
    assert.throws(() => parseSkillMarkdown("---\nname: valid\ndescription: x\n---\n"), /workflow/u);
  });

  it("shares project Skills across Threads and nested workspaces without a Thread ID", async () => {
    await fixture(async ({ project, nested, home, trash, store }) => {
      await store.create("project", "check-api", "Review API diffs.", "Inspect the diff.");
      await store.create("user", "check-api", "Review across projects.", "Inspect the API.");
      const anotherThread = new SkillStore(nested, home, trash);
      assert.equal(await anotherThread.projectRoot(), await realpath(project));
      const listing = await anotherThread.list();
      assert.equal(listing.projectDirectory, path.join(await realpath(project), ".easy_code_skills"));
      assert.equal(listing.userDirectory, path.join(await realpath(home), ".easy_code_skills"));
      assert.equal(listing.project[0]?.description, "Review API diffs.");
      assert.equal(listing.user[0]?.description, "Review across projects.");
      assert.notEqual(listing.project[0]?.directory, listing.user[0]?.directory);
      assert.equal((await anotherThread.read("project", "check-api")).name, "check-api");
    });
  });

  it("shares user Skills across projects, but keeps project Skills local", async () => {
    await fixture(async ({ project, home, trash, store }) => {
      const secondProject = path.join(path.dirname(project), "other-project");
      await mkdir(secondProject);
      await store.create("user", "common-check", "Check any project.", "Review the code.");
      await store.create("project", "local-check", "Check only this project.", "Review the code.");
      const otherStore = new SkillStore(secondProject, home, trash);
      assert.equal(await otherStore.projectRoot(), await realpath(secondProject));
      const listing = await otherStore.list();
      assert.deepEqual(listing.user.map(skill => skill.name), ["common-check"]);
      assert.deepEqual(listing.project, []);
    });
  });

  it("keeps supporting files, rejects stale edits and archives only the selected Skill", async () => {
    await fixture(async ({ project, trash, store }) => {
      const initial = await store.create("project", "review-code", "Review changed code.",
        "Use the checklist.", [{ path: "references/checklist.md", content: "Check behavior." }]);
      assert.deepEqual(initial.files, ["SKILL.md", "references/checklist.md"]);
      const changed = await store.modify("project", "review-code", initial.version,
        createSkillMarkdown("review-code", "Review code when requested.", "Follow the checklist."),
        [{ operation: "upsert", path: "assets/template.md", content: "Template" }]);
      assert.equal((await store.read("project", "review-code", "references/checklist.md")).content,
        "Check behavior.");
      assert.ok(changed.files.includes("assets/template.md"));
      await assert.rejects(store.modify("project", "review-code", initial.version,
        createSkillMarkdown("review-code", "old", "old")), /changed since it was read/u);
      await assert.rejects(store.delete("project", "review-code", initial.version), /changed since it was read/u);
      const archived = await store.delete("project", "review-code", changed.version);
      assert.equal(path.dirname(archived.archivedAt), await realpath(trash));
      assert.match(await readFile(path.join(archived.archivedAt, "SKILL.md"), "utf8"), /Review code when requested/u);
      assert.equal((await store.list()).project.length, 0);
      await assert.rejects(stat(path.join(project, ".easy_code_skills", "review-code")), { code: "ENOENT" });
    });
  });

  it("rejects traversal and linked Skill directories without touching outside files", async () => {
    await fixture(async ({ project, store }) => {
      await assert.rejects(store.create("project", "safe", "Safe Skill", "Do work.",
        [{ path: "../outside.md", content: "bad" }]), /unsafe segment/u);
      await assert.rejects(store.read("project", "../outside"), /Skill name/u);
      const outside = path.join(project, "outside.md");
      await writeFile(outside, "kept");
      const skillRoot = path.join(project, ".easy_code_skills");
      await mkdir(skillRoot, { recursive: true });
      try {
        await symlink(project, path.join(skillRoot, "linked"), "junction");
        assert.ok((await store.list()).warnings.some(warning => warning.includes("linked")));
        await assert.rejects(store.read("project", "linked"), /symlink|junction|redirect|not a real directory/u);
      } catch (error) {
        if (!(["EPERM", "EACCES"] as unknown[]).includes((error as NodeJS.ErrnoException).code)) throw error;
      }
      await mkdir(path.join(skillRoot, "linked-file"));
      try {
        await symlink(outside, path.join(skillRoot, "linked-file", "SKILL.md"), "file");
        assert.ok((await store.list()).warnings.some(warning => warning.includes("linked-file")));
        await assert.rejects(store.read("project", "linked-file"), /symlink|junction/u);
      } catch (error) {
        if (!(["EPERM", "EACCES"] as unknown[]).includes((error as NodeJS.ErrnoException).code)) throw error;
      }
      assert.equal(await readFile(outside, "utf8"), "kept");
    });
  });

  it("recovers an interrupted staged replacement and an abandoned mutation lock", async () => {
    await fixture(async ({ project, store }) => {
      const created = await store.create("project", "recoverable", "Recover interrupted updates.", "Check the files.");
      const root = path.join(project, ".easy_code_skills");
      const target = path.join(root, "recoverable");
      await rename(target, path.join(root, `.backup-recoverable-${randomUUID()}`));
      assert.equal((await store.read("project", "recoverable")).version, created.version);
      const lock = path.join(root, ".lock-recoverable");
      await writeFile(lock, JSON.stringify({ pid: 99999999, at: Date.now() - 120_000 }));
      const oldTime = new Date(Date.now() - 120_000);
      await utimes(lock, oldTime, oldTime);
      const result = await store.modify("project", "recoverable", created.version,
        createSkillMarkdown("recoverable", "Recovered Skill.", "Check the files again."));
      assert.notEqual(result.version, created.version);
      await assert.rejects(stat(lock), { code: "ENOENT" });
    });
  });

  it("exposes five separate built-in tools and binds writes to their exact Skill", async () => {
    await fixture(async ({ project, home, trash }) => {
      const workspace = await WorkspaceManager.create(project);
      const store = new SkillStore(project, home, trash);
      const context = { workspaceRoot: project, mode: "code", threadId: "thread_a", turnId: "turn_a",
        agentRole: "main_agent" } as ToolContext;
      const list = new ListSkillsTool(workspace, store);
      const read = new ReadSkillTool(workspace, store);
      const create = new CreateSkillTool(workspace, store);
      const modify = new ModifySkillTool(workspace, store);
      const remove = new DeleteSkillTool(workspace, store);
      assert.equal(create.approvalTarget({ scope: "user", name: "helper" }).name,
        "create_skill:user:helper");
      assert.equal(remove.approvalTarget({ scope: "project", name: "helper" }).name,
        "delete_skill:project:helper");
      assert.equal((await create.execute({ scope: "project", name: "helper",
        description: "Help on request.", instructions: "Provide help." }, context)).ok, true);
      assert.equal((await list.execute({}, context)).ok, true);
      const loaded = await read.execute({ scope: "project", name: "helper" }, context);
      assert.equal(loaded.ok, true);
      const version = (loaded.data as { version: string }).version;
      assert.equal((await modify.execute({ scope: "project", name: "helper", expectedVersion: version,
        skillMarkdown: createSkillMarkdown("helper", "Help on demand.", "Provide verified help.") }, context)).ok, true);
      const fresh = await read.execute({ scope: "project", name: "helper" }, context);
      assert.equal((await remove.execute({ scope: "project", name: "helper",
        expectedVersion: (fresh.data as { version: string }).version }, context)).ok, true);
      assert.equal((await list.execute({}, context)).ok, true);
    });
  });
});
