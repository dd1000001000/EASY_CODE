import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../src/core/types.js";
import { DocumentConverter, ThreadDocumentService, ThreadResourceStore } from "../src/resources/index.js";
import { htmlToMarkdown, parseSearchHtml } from "../src/resources/web-content.js";
import { ReadDocumentTool, ReadFileTool, SearchFilesTool, UpdateFileTool } from "../src/tools/index.js";
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

    const search = parseSearchHtml(`<div class="result results_links"><h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=1">First &amp; Docs</a></h2><a class="result__snippet">A &amp; B</a></div>
      <div class="result results_links"><h2 class="result__title"><a href="https://example.com/b" class="result__a">Second</a></h2><a class="result__snippet">C</a></div>`, 1);
    assert.deepEqual(search, [{ title: "First & Docs", url: "https://example.com/a", snippet: "A & B" }]);
    assert.deepEqual(parseSearchHtml('<a class="result__a" href="javascript:alert(1)">Bad</a>', 5), []);
  });

  it("uses the shared converter for workspace documents and reuses an unchanged Thread snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-document-workspace-"));
    const data = await mkdtemp(path.join(os.tmpdir(), "easy-code-document-data-"));
    try {
      await writeFile(path.join(root, "requirements.md"), "# Requirements\n\nShared conversion path.\n", "utf8");
      const workspace = await WorkspaceManager.create(root);
      const store = new ThreadResourceStore(data);
      const documents = new ThreadDocumentService(new DocumentConverter(data), store);
      const tool = new ReadDocumentTool(workspace, documents);

      const first = await tool.execute({ path: "requirements.md" }, context(root));
      const second = await tool.execute({ path: "requirements.md" }, context(root));
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      const firstData = first.data as { uri: string; id: string; readOnly: boolean };
      const secondData = second.data as { uri: string; id: string };
      assert.equal(firstData.readOnly, true);
      assert.equal(secondData.id, firstData.id);
      assert.equal((await store.list("thread_resource_test")).length, 1);

      const read = await new ReadFileTool(workspace, store).execute(
        { path: firstData.uri }, context(root),
      );
      assert.equal(read.ok, true);
      assert.match((read.data as { content: string }).content, /Shared conversion path/u);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(data, { recursive: true, force: true });
    }
  });

  it("enforces one configurable byte limit across conversion and resource storage", async () => {
    const data = await mkdtemp(path.join(os.tmpdir(), "easy-code-document-limit-"));
    try {
      const store = new ThreadResourceStore(data, 8);
      const documents = new ThreadDocumentService(new DocumentConverter(data), store);
      assert.equal(documents.maxBytes, 8);
      await assert.rejects(
        documents.import({ threadId: "thread_resource_test", filename: "large.txt", data: Buffer.from("123456789") }),
        /configured 8-byte limit/u,
      );
      await assert.rejects(
        store.create({ threadId: "thread_resource_test", filename: "large.md", kind: "document",
          mediaType: "text/markdown", markdown: "small", byteSize: 9 }),
        /configured 8-byte limit/u,
      );
    } finally { await rm(data, { recursive: true, force: true }); }
  });
});
