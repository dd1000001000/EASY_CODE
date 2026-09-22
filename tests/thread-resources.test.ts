import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../src/core/types.js";
import { ThreadResourceStore } from "../src/resources/index.js";
import { htmlToMarkdown, parseSearchRss } from "../src/resources/web-content.js";
import { ReadFileTool, SearchFilesTool, UpdateFileTool } from "../src/tools/index.js";
import { WorkspaceManager } from "../src/workspace/index.js";
import { describe, it } from "./harness.js";

function context(root: string, threadId = "thread_resource_test"): ToolContext {
  return {
    workspaceRoot: root, mode: "code", threadId, turnId: "turn_resource_test",
    approvalPolicy: "safe", requestApproval: async () => false,
    commandTimeoutMs: 2_000, maxOutputChars: 16_000,
  };
}

describe("Thread resources", () => {
  it("stores, ranges, searches, and enforces Thread ownership for immutable resources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-resource-workspace-"));
    const data = await mkdtemp(path.join(os.tmpdir(), "easy-code-resource-data-"));
    try {
      const workspace = await WorkspaceManager.create(root);
      const store = new ThreadResourceStore(data);
      const resource = await store.create({
        threadId: "thread_resource_test", filename: "requirements.docx", kind: "document",
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        markdown: "# Requirements\n\nfirst line\nsecond needle line\nlast line", byteSize: 321,
      });
      assert.match(resource.uri, /^thread-resource:\/\/resource_[0-9a-f-]{36}\/content\.md$/u);

      const read = await new ReadFileTool(workspace, store).execute(
        { path: resource.uri, startLine: 3, endLine: 4 }, context(root),
      );
      assert.equal(read.ok, true);
      assert.equal((read.data as { content: string }).content, "first line\nsecond needle line");
      assert.equal((read.data as { readOnly: boolean }).readOnly, true);

      const empty = await store.create({
        threadId: "thread_resource_test", filename: "empty.txt", kind: "document",
        mediaType: "text/plain", markdown: "", byteSize: 0,
      });
      const emptyRead = await new ReadFileTool(workspace, store).execute(
        { path: empty.uri }, context(root),
      );
      assert.equal(emptyRead.ok, true);
      assert.equal((emptyRead.data as { content: string }).content, "");

      const search = await new SearchFilesTool(workspace, store).execute(
        { scope: "thread_resources", query: "needle" }, context(root),
      );
      assert.equal(search.ok, true);
      assert.equal((search.data as { matches: Array<{ path: string }> }).matches[0]?.path, resource.uri);

      const wrongThread = await new ReadFileTool(workspace, store).execute(
        { path: resource.uri }, context(root, "thread_other"),
      );
      assert.equal(wrongThread.ok, false);

      const update = await new UpdateFileTool(workspace).execute(
        { path: resource.uri, expectedHash: "0".repeat(64), edits: [{ oldText: "first", newText: "changed" }] }, context(root),
      );
      assert.equal(update.ok, false);
      assert.match(update.error ?? "", /immutable/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  });

  it("extracts readable Markdown and bounded search previews", () => {
    const page = htmlToMarkdown("<html><head><title>Example &amp; Docs</title></head><body><nav>menu</nav><h1>Guide</h1><p>Hello <a href='/next'>world</a>.</p><script>secret()</script></body></html>", "https://example.com/docs");
    assert.equal(page.title, "Example & Docs");
    assert.match(page.markdown, /# Guide/u);
    assert.match(page.markdown, /\[world\]\(https:\/\/example\.com\/next\)/u);
    assert.doesNotMatch(page.markdown, /secret/u);

    const rss = parseSearchRss("<rss><channel><item><title>First</title><link>https://example.com/a</link><description>A &amp; B</description></item><item><title>Second</title><link>https://example.com/b</link><description>C</description></item></channel></rss>", 1);
    assert.deepEqual(rss, [{ title: "First", url: "https://example.com/a", snippet: "A & B" }]);
  });
});
