import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDefaultEasyCodeConfig } from "../src/config/defaults.js";
import type { ChatMessage, ImageAttachment } from "../src/core/types.js";
import {
  assertThreadImageNumberAvailable,
  ImageStore,
  SystemClipboardImageReader,
  assertDataDirectoryOutsideWorkspace,
  chooseClipboardMediaType,
  inspectImageBuffer,
  nextThreadImageNumber,
  prepareDataDirectoryOutsideWorkspace,
  resolveDataDirectoryOutsideWorkspace,
  runClipboardCommand,
  validateImageAttachmentCollection,
} from "../src/images/index.js";
import { createProvider, type JsonPostRequest } from "../src/providers/index.js";
import { createStorage } from "../src/storage/database.js";
import {
  deserializeChatMessage,
  serializeChatMessage,
} from "../src/threads/serialization.js";
import { ThreadStore } from "../src/threads/thread-store.js";
import { describe, it } from "./harness.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PNG_16X16 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAEklEQVR4nGNgGAWjYBSMAggAAAQQAAFVN1rQAAAAAElFTkSuQmCC",
  "base64",
);
const GIF_1X1 = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
);

function successResponse(): {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
} {
  return {
    statusCode: 200,
    headers: {},
    body: JSON.stringify({
      choices: [{ message: { role: "assistant", content: "seen" } }],
    }),
  };
}

describe("image attachments", () => {
  it("allocates image labels monotonically across a thread and pending queue", () => {
    const first: ImageAttachment = {
      id: "image_00000000-0000-4000-8000-000000000001",
      label: "Image #1",
      mediaType: "image/png",
      storageKey:
        "attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-000000000001.png",
      sha256: "1".repeat(64),
      byteSize: PNG_16X16.length,
      width: 16,
      height: 16,
    };
    const pending: ImageAttachment = {
      ...first,
      id: "image_00000000-0000-4000-8000-000000000004",
      label: "Image #4",
      storageKey:
        "attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-000000000004.png",
      sha256: "4".repeat(64),
    };
    assert.equal(nextThreadImageNumber([
      { role: "user", content: "first", images: [first] },
    ], [pending]), 5);

    const last = { ...first, label: "Image #999" };
    assert.equal(nextThreadImageNumber([
      { role: "user", content: "last", images: [last] },
    ]), 1_000);
    assert.throws(
      () => assertThreadImageNumberAvailable(1_000),
      /999 image attachment limit/u,
    );
  });

  it("inspects supported image headers and rejects unsafe dimensions", () => {
    const inspected = inspectImageBuffer(PNG_1X1);
    assert.equal(inspected.mediaType, "image/png");
    assert.equal(inspected.width, 1);
    assert.equal(inspected.height, 1);
    assert.match(inspected.sha256, /^[a-f0-9]{64}$/u);

    assert.throws(
      () => inspectImageBuffer(PNG_1X1, { maxImageEdge: 0 }),
      /dimensions/u,
    );
    assert.throws(() => inspectImageBuffer(Buffer.from("not an image")), /Unsupported|damaged/u);
  });

  it("rejects animated, truncated, and trailing image payloads", () => {
    assert.equal(inspectImageBuffer(GIF_1X1).mediaType, "image/gif");
    const imageBlock = GIF_1X1.subarray(GIF_1X1.indexOf(0x2c), GIF_1X1.length - 1);
    const animatedGif = Buffer.concat([
      GIF_1X1.subarray(0, GIF_1X1.length - 1),
      imageBlock,
      Buffer.from([0x3b]),
    ]);
    assert.throws(() => inspectImageBuffer(animatedGif), /Animated GIF/u);
    assert.throws(
      () => inspectImageBuffer(Buffer.concat([PNG_1X1, Buffer.from("polyglot")])),
      /trailing data/u,
    );
    assert.throws(
      () => inspectImageBuffer(PNG_1X1.subarray(0, PNG_1X1.length - 4)),
      /truncated|damaged/u,
    );
  });

  it("copies images into a private thread store and verifies integrity on load", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-images-"));
    try {
      const source = path.join(root, "source.png");
      const dataDir = path.join(root, "data");
      await writeFile(source, PNG_1X1);
      const store = new ImageStore(dataDir);
      const attachment = await store.importFile(
        "thread_test",
        "Image #1",
        source,
        "source.png",
      );

      assert.equal(attachment.sourceName, "source.png");
      assert.match(attachment.storageKey, /^attachments\/[a-f0-9]{32}\//u);
      assert.deepEqual(await store.load("thread_test", attachment), PNG_1X1);
      const persisted = serializeChatMessage({
        role: "user",
        content: "Inspect [Image #1]",
        images: [attachment],
      });
      assert.doesNotMatch(persisted, new RegExp(PNG_1X1.toString("base64"), "u"));
      assert.match(persisted, /"storageKey":"attachments\//u);
      assert.deepEqual(deserializeChatMessage(persisted), {
        role: "user",
        content: "Inspect [Image #1]",
        images: [attachment],
      });
      assert.throws(
        () => deserializeChatMessage(JSON.stringify({
          role: "user",
          content: "unsafe",
          images: [{ ...attachment, base64: PNG_1X1.toString("base64") }],
        })),
        /shape/u,
      );

      const storedPath = path.join(dataDir, ...attachment.storageKey.split("/"));
      await writeFile(storedPath, Buffer.from(PNG_1X1).fill(0, 30, 31));
      await assert.rejects(
        store.load("thread_test", attachment),
        /integrity check|metadata|checksum/u,
      );
      await assert.rejects(
        store.load("thread_test", { ...attachment, storageKey: "../../outside.png" }),
        /metadata|storage key/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads clipboard images through platform helpers without invoking a shell", async () => {
    const calls: Array<{
      program: string;
      args: readonly string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
    }> = [];
    const clipboard = new SystemClipboardImageReader({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows", QWEN_API_KEY: "must-not-leak" },
      runCommand: async (program, args, options) => {
        calls.push({ program, args, cwd: options.cwd, env: options.env });
        return PNG_1X1;
      },
    });

    assert.deepEqual(await clipboard.readImage(), PNG_1X1);
    assert.equal(
      calls[0]?.program,
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    assert.equal(calls[0]?.args.includes("-STA"), true);
    assert.equal(path.isAbsolute(calls[0]?.cwd ?? ""), true);
    assert.notEqual(calls[0]?.cwd, process.cwd());
    assert.equal(calls[0]?.env.QWEN_API_KEY, undefined);
    await assert.rejects(lstat(calls[0]?.cwd ?? ""), /ENOENT/u);
    assert.equal(chooseClipboardMediaType("text/plain\nimage/jpeg\nimage/png"), "image/png");
    assert.equal(chooseClipboardMediaType("text/plain"), undefined);
  });

  it("skips relative and workspace PATH entries for Linux clipboard helpers", async () => {
    const programs: string[] = [];
    const clipboard = new SystemClipboardImageReader({
      platform: "linux",
      currentDirectory: "/workspace",
      env: {
        PATH: ".:/workspace/bin:/usr/bin",
        WAYLAND_DISPLAY: "wayland-0",
        DEEPSEEK_API_KEY: "must-not-leak",
      },
      runCommand: async (program, args, options) => {
        programs.push(program);
        assert.equal(options.env.DEEPSEEK_API_KEY, undefined);
        return args.includes("--list-types") ? Buffer.from("image/png\n") : PNG_1X1;
      },
    });

    assert.deepEqual(await clipboard.readImage(), PNG_1X1);
    assert.deepEqual(programs, ["/usr/bin/wl-paste", "/usr/bin/wl-paste"]);
  });

  it("requires an absolute helper and terminates it when clipboard capture is aborted", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "easy-code-clipboard-runner-"));
    try {
      await assert.rejects(
        runClipboardCommand("node", [], {
          cwd,
          env: {},
          maxOutputBytes: 1_024,
          timeoutMs: 5_000,
        }),
        /absolute/u,
      );
      const controller = new AbortController();
      const startedAt = Date.now();
      const pending = runClipboardCommand(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          cwd,
          env: {},
          maxOutputBytes: 1_024,
          timeoutMs: 5_000,
          signal: controller.signal,
        },
      );
      setTimeout(() => controller.abort(), 25);
      await assert.rejects(pending, (error: unknown) =>
        error instanceof Error && error.name === "AbortError",
      );
      assert.ok(Date.now() - startedAt < 2_000);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("binds stored attachments to their thread and enforces collection limits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-image-binding-"));
    try {
      const store = new ImageStore(path.join(root, "data"));
      const attachment = await store.importBuffer(
        "thread_owner",
        "Image #1",
        PNG_1X1,
      );
      await assert.rejects(store.load("thread_other", attachment), /metadata/u);
      assert.deepEqual(validateImageAttachmentCollection([attachment]), {
        imageCount: 1,
        totalBytes: attachment.byteSize,
        totalPixels: 1,
      });
      assert.throws(
        () => validateImageAttachmentCollection([attachment], {
          maxTotalBytes: attachment.byteSize - 1,
        }),
        /combined size/u,
      );
      assert.throws(
        () => validateImageAttachmentCollection([attachment], { maxTotalPixels: 0 }),
        /pixel limit/u,
      );
      await store.remove("thread_owner", attachment);
      await store.remove("thread_owner", attachment);
      await assert.rejects(store.load("thread_owner", attachment), /ENOENT/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("confines workspace image imports to a canonical allowed root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-image-workspace-"));
    try {
      const workspace = path.join(root, "workspace");
      const outside = path.join(root, "outside.png");
      const inside = path.join(workspace, "inside.png");
      await mkdir(workspace);
      await writeFile(inside, PNG_1X1);
      await writeFile(outside, PNG_1X1);
      const store = new ImageStore(path.join(root, "data"));
      const attachment = await store.importFile(
        "thread_workspace",
        "Image #1",
        inside,
        "inside.png",
        workspace,
      );
      assert.deepEqual(await store.load("thread_workspace", attachment), PNG_1X1);
      await assert.rejects(
        store.importFile(
          "thread_workspace",
          "Image #2",
          outside,
          "outside.png",
          workspace,
        ),
        /escapes the allowed workspace/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects data directories that canonically resolve inside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-data-boundary-"));
    try {
      const workspace = path.join(root, "workspace");
      const outside = path.join(root, "outside");
      await mkdir(workspace);
      await mkdir(outside);
      await assert.rejects(
        assertDataDirectoryOutsideWorkspace(workspace, workspace),
        /outside the workspace|pollute Git/u,
      );
      await assert.rejects(
        assertDataDirectoryOutsideWorkspace(
          path.join(workspace, "missing", "data"),
          workspace,
        ),
        /outside the workspace|pollute Git/u,
      );
      const alias = path.join(outside, "workspace-alias");
      await symlink(
        workspace,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      await assert.rejects(
        assertDataDirectoryOutsideWorkspace(path.join(alias, "private"), workspace),
        /outside the workspace|pollute Git/u,
      );
      await assert.doesNotReject(
        assertDataDirectoryOutsideWorkspace(path.join(outside, "data"), workspace),
      );
      assert.equal(
        await resolveDataDirectoryOutsideWorkspace(
          path.join(outside, "missing", "data"),
          workspace,
        ),
        path.join(await realpath(outside), "missing", "data"),
      );
      const prepared = await prepareDataDirectoryOutsideWorkspace(
        path.join(outside, "prepared", "data"),
        workspace,
      );
      assert.equal((await lstat(prepared)).isDirectory(), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("commits referenced images and never lets pending cleanup delete them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-image-commit-"));
    try {
      const store = new ImageStore(root);
      const attachment = await store.importBuffer(
        "thread_commit",
        "Image #1",
        PNG_1X1,
      );
      await store.commit("thread_commit", attachment);
      await store.remove("thread_commit", attachment);
      assert.deepEqual(await store.load("thread_commit", attachment), PNG_1X1);
      const pendingLeaseDirectories = await readdir(path.join(root, "attachments", ".pending"));
      assert.equal(pendingLeaseDirectories.length, 0);
      await store.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains the pending marker when commit races an active image GC", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-image-commit-race-"));
    const dataDir = path.join(root, "data");
    const leaseId = "lease_00000000-0000-4000-8000-000000000707";
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      threads.create({
        threadId: "thread_commit_race",
        workspaceRoot: path.join(root, "workspace"),
        mode: "code",
        provider: "qwen",
        model: "qwen3-vl-plus",
      });
      const store = new ImageStore(dataDir, { leaseId });
      const attachment = await store.importBuffer(
        "thread_commit_race",
        "Image #1",
        PNG_1X1,
      );
      threads.appendEvent("thread_commit_race", {
        type: "message.user",
        turnId: "turn_commit_race",
        payload: {
          message: { role: "user", content: "inspect", images: [attachment] },
        },
      });

      const storageParts = attachment.storageKey.split("/");
      const markerPath = path.join(
        dataDir,
        "attachments",
        ".pending",
        leaseId,
        storageParts[1] ?? "",
        `${storageParts[2] ?? ""}.pending.json`,
      );
      const lockPath = path.join(dataDir, "attachments", ".gc-lock");
      await writeFile(lockPath, `${JSON.stringify({
        version: 1,
        token: "gc_00000000-0000-4000-8000-000000000707",
        pid: process.pid,
        createdAt: Date.now(),
      })}\n`, "utf8");

      await store.commit("thread_commit_race", attachment);
      assert.equal((await lstat(markerPath)).isFile(), true);
      assert.deepEqual(await store.load("thread_commit_race", attachment), PNG_1X1);

      await rm(lockPath);
      const result = await store.garbageCollect();
      assert.equal(result.committedRecovered, 1);
      await assert.rejects(lstat(markerPath), /ENOENT/u);
      assert.deepEqual(await store.load("thread_commit_race", attachment), PNG_1X1);
      await store.shutdown();
    } finally {
      storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("eagerly removes this process's uncommitted images during graceful shutdown", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-image-shutdown-"));
    try {
      const store = new ImageStore(root);
      const attachment = await store.importBuffer(
        "thread_shutdown",
        "Image #1",
        PNG_1X1,
      );
      const result = await store.shutdown();
      assert.equal(result.orphanImagesRemoved, 1);
      await assert.rejects(
        store.load("thread_shutdown", attachment),
        /ENOENT/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves active pending images and collects them after their lease becomes stale", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-image-active-"));
    let now = Date.now();
    let ownerAlive = true;
    try {
      const owner = new ImageStore(root, {
        orphanGraceMs: 100,
        now: () => now,
        processId: 101,
        leaseId: "lease_00000000-0000-4000-8000-000000000101",
        isProcessAlive: (pid) => pid === 101 && ownerAlive,
      });
      const attachment = await owner.importBuffer(
        "thread_active",
        "Image #1",
        PNG_1X1,
      );
      now += 1_000;
      const collector = new ImageStore(root, {
        orphanGraceMs: 100,
        now: () => now,
        processId: 202,
        leaseId: "lease_00000000-0000-4000-8000-000000000202",
        isProcessAlive: (pid) => pid === 101 && ownerAlive,
      });
      const activeResult = await collector.initialize();
      assert.equal(activeResult.pendingImagesPreserved, 1);
      assert.deepEqual(await owner.load("thread_active", attachment), PNG_1X1);

      ownerAlive = false;
      const staleResult = await collector.garbageCollect();
      assert.equal(staleResult.orphanImagesRemoved, 1);
      await assert.rejects(owner.load("thread_active", attachment), /ENOENT/u);
      await collector.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a referenced pending marker and removes old unreferenced final files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-image-gc-"));
    const dataDir = path.join(root, "data");
    let now = Date.now();
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      threads.create({
        threadId: "thread_gc",
        workspaceRoot: path.join(root, "workspace"),
        mode: "code",
        provider: "qwen",
        model: "qwen3-vl-plus",
      });
      const owner = new ImageStore(dataDir, {
        orphanGraceMs: 100,
        now: () => now,
        processId: 303,
        leaseId: "lease_00000000-0000-4000-8000-000000000303",
        isProcessAlive: () => false,
      });
      const referenced = await owner.importBuffer(
        "thread_gc",
        "Image #1",
        PNG_1X1,
      );
      threads.appendEvent("thread_gc", {
        type: "message.user",
        turnId: "turn_gc",
        payload: {
          message: { role: "user", content: "inspect", images: [referenced] },
        },
      });

      const orphan = await owner.importBuffer(
        "thread_gc",
        "Image #2",
        PNG_1X1,
      );
      await owner.commit("thread_gc", orphan);
      const orphanPath = path.join(dataDir, ...orphan.storageKey.split("/"));
      const old = new Date(now - 1_000);
      await utimes(orphanPath, old, old);
      now += 1_000;

      const collector = new ImageStore(dataDir, {
        orphanGraceMs: 100,
        now: () => now,
        processId: 404,
        leaseId: "lease_00000000-0000-4000-8000-000000000404",
        isProcessAlive: () => false,
      });
      const result = await collector.initialize();
      assert.equal(result.committedRecovered, 1);
      assert.equal(result.orphanImagesRemoved, 1);
      assert.deepEqual(await collector.load("thread_gc", referenced), PNG_1X1);
      await assert.rejects(collector.load("thread_gc", orphan), /ENOENT/u);
      await collector.shutdown();
    } finally {
      storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("conservatively retains an image when its pending marker is damaged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-image-marker-"));
    let now = Date.now();
    const leaseId = "lease_00000000-0000-4000-8000-000000000505";
    try {
      const owner = new ImageStore(root, {
        orphanGraceMs: 100,
        now: () => now,
        processId: 505,
        leaseId,
        isProcessAlive: () => false,
      });
      const attachment = await owner.importBuffer(
        "thread_marker",
        "Image #1",
        PNG_1X1,
      );
      const storageParts = attachment.storageKey.split("/");
      const finalPath = path.join(root, ...storageParts);
      const markerPath = path.join(
        root,
        "attachments",
        ".pending",
        leaseId,
        storageParts[1] ?? "",
        `${storageParts[2] ?? ""}.pending.json`,
      );
      await writeFile(markerPath, "{damaged", "utf8");
      const old = new Date(now - 1_000);
      await utimes(finalPath, old, old);
      now += 1_000;

      const collector = new ImageStore(root, {
        orphanGraceMs: 100,
        now: () => now,
        processId: 606,
        leaseId: "lease_00000000-0000-4000-8000-000000000606",
        isProcessAlive: () => false,
      });
      const result = await collector.initialize();
      assert.equal(result.pendingImagesPreserved, 1);
      assert.equal(result.orphanImagesRemoved, 0);
      assert.deepEqual(await owner.load("thread_marker", attachment), PNG_1X1);
      await collector.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects attachment roots and thread directories that are links", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-image-links-"));
    try {
      const external = path.join(root, "external");
      await mkdir(external);
      const linkedData = path.join(root, "linked-data");
      await mkdir(linkedData);
      await symlink(
        external,
        path.join(linkedData, "attachments"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await assert.rejects(
        new ImageStore(linkedData).importBuffer("thread_link", "Image #1", PNG_1X1),
        /symlink|junction/u,
      );

      const dataDir = path.join(root, "data");
      const store = new ImageStore(dataDir);
      const first = await store.importBuffer("thread_link", "Image #1", PNG_1X1);
      const threadDirectory = path.dirname(
        path.join(dataDir, ...first.storageKey.split("/")),
      );
      await rm(threadDirectory, { recursive: true, force: true });
      await symlink(
        external,
        threadDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
      await assert.rejects(
        store.importBuffer("thread_link", "Image #2", PNG_1X1),
        /symlink|junction/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers image references from JSONL and SQLite without persisting Base64", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "easy-code-image-thread-"));
    const dataDir = path.join(root, "data");
    const imageStore = new ImageStore(dataDir);
    const attachment = await imageStore.importBuffer(
      "thread_images",
      "Image #1",
      PNG_1X1,
      "clipboard",
    );
    const storage = createStorage(dataDir);
    try {
      const threads = new ThreadStore(storage);
      threads.create({
        threadId: "thread_images",
        workspaceRoot: path.join(root, "workspace"),
        mode: "code",
        provider: "qwen",
        model: "qwen3-vl-plus",
      });
      const message = {
        role: "user" as const,
        content: "Inspect [Image #1]",
        images: [attachment],
      };
      threads.appendEvent("thread_images", {
        type: "message.user",
        turnId: "turn_images",
        payload: { content: message.content, message },
      });
      threads.appendEvent("thread_images", {
        type: "message.user.synthetic",
        turnId: "turn_images",
        payload: {
          ...message,
          content: "Image returned by read_image",
        },
      });

      const recovered = threads.recover("thread_images");
      assert.equal(recovered.messages.length, 2);
      assert.equal(
        recovered.messages.every(
          (item) => item.role === "user" && item.images?.[0]?.storageKey === attachment.storageKey,
        ),
        true,
      );
      const journal = await readFile(
        path.join(dataDir, "threads", "thread_images", "events.jsonl"),
        "utf8",
      );
      const projected = storage.db
        .prepare<[string], { user_message_json: string }>(
          "SELECT user_message_json FROM turns WHERE id = ?",
        )
        .get("turn_images")?.user_message_json ?? "";
      const base64 = PNG_1X1.toString("base64");
      assert.doesNotMatch(journal, new RegExp(base64, "u"));
      assert.doesNotMatch(projected, new RegExp(base64, "u"));
      assert.match(journal, /attachments\//u);
      assert.match(projected, /attachments\//u);
    } finally {
      storage.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hydrates a vision request only at the provider boundary", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.qwen.apiKey = "test-key";
    const attachment: ImageAttachment = {
      id: "image_00000000-0000-4000-8000-000000000000",
      label: "Image #1",
      mediaType: "image/png",
      storageKey:
        "attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-000000000000.png",
      sha256: "0".repeat(64),
      byteSize: PNG_16X16.length,
      width: 16,
      height: 16,
    };
    const captured: JsonPostRequest[] = [];
    let loadCount = 0;
    const provider = createProvider(config, "qwen", "qwen3-vl-plus", {
      loadImage: async () => {
        loadCount += 1;
        return PNG_16X16;
      },
      transport: async (request) => {
        captured.push(request);
        return successResponse();
      },
    });

    await provider.complete({
      messages: [{ role: "user", content: "What is shown?", images: [attachment] }],
    });

    assert.equal(loadCount, 1);
    const body = JSON.parse(captured[0]?.body ?? "{}") as {
      messages?: Array<{ content?: Array<Record<string, unknown>> }>;
    };
    assert.doesNotMatch(captured[0]?.body ?? "", /storageKey|attachments\//u);
    const parts = body.messages?.[0]?.content ?? [];
    assert.deepEqual(parts[0], { type: "text", text: "[Image #1]" });
    const imagePart = parts[1] as { image_url?: { url?: string } } | undefined;
    assert.equal(
      imagePart?.image_url?.url,
      `data:image/png;base64,${PNG_16X16.toString("base64")}`,
    );
    assert.deepEqual(parts[2], { type: "text", text: "What is shown?" });
  });

  it("preserves inline image-marker order for multi-image comparisons", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.qwen.apiKey = "test-key";
    const images: ImageAttachment[] = [1, 2].map((index) => ({
      id: `image_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      label: `Image #${index}`,
      mediaType: "image/png",
      storageKey:
        `attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-${String(index).padStart(12, "0")}.png`,
      sha256: String(index).repeat(64),
      byteSize: PNG_16X16.length,
      width: 16,
      height: 16,
    }));
    let body = "";
    const provider = createProvider(config, "qwen", "qwen3-vl-plus", {
      loadImage: async () => PNG_16X16,
      transport: async (request) => {
        body = request.body;
        return successResponse();
      },
    });

    await provider.complete({
      messages: [{
        role: "user",
        content: "Compare [Image #2] against [Image #1].",
        images,
      }],
    });

    const parsed = JSON.parse(body) as {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
    const parts = parsed.messages[0]?.content ?? [];
    assert.deepEqual(
      parts.map((part) => part.type === "text" ? part.text : "<image>"),
      ["Compare ", "[Image #2]", "<image>", " against ", "[Image #1]", "<image>", "."],
    );
  });

  it("uses the multimodal Chat Completions shape for DeepSeek vision models", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.deepseek.apiKey = "test-key";
    const attachment: ImageAttachment = {
      id: "image_00000000-0000-4000-8000-000000000001",
      label: "Image #1",
      mediaType: "image/png",
      storageKey:
        "attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-000000000001.png",
      sha256: "1".repeat(64),
      byteSize: PNG_1X1.length,
      width: 1,
      height: 1,
    };
    let body = "";
    const provider = createProvider(
      config,
      "deepseek",
      "deepseek-v4-flash-vision-exp",
      {
        loadImage: async () => PNG_1X1,
        transport: async (request) => {
          body = request.body;
          return successResponse();
        },
      },
    );

    await provider.complete({
      messages: [{ role: "user", content: "Inspect it", images: [attachment] }],
    });
    assert.match(body, /"type":"image_url"/u);
    assert.match(body, /data:image\/png;base64/u);
  });

  it("sends images only with the GLM-5.3-Flash vision model", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.glm.apiKey = "test-key";
    const attachment: ImageAttachment = {
      id: "image_00000000-0000-4000-8000-000000000005",
      label: "Image #1",
      mediaType: "image/png",
      storageKey:
        "attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-000000000005.png",
      sha256: "5".repeat(64),
      byteSize: PNG_1X1.length,
      width: 1,
      height: 1,
    };
    let flashBody = "";
    const flash = createProvider(config, "glm", "glm-5.3-flash", {
      loadImage: async () => PNG_1X1,
      transport: async (request) => {
        flashBody = request.body;
        return successResponse();
      },
    });
    await flash.complete({
      messages: [{ role: "user", content: "Inspect it", images: [attachment] }],
      currentTurnImageIds: [attachment.id],
    });
    assert.match(flashBody, /"model":"glm-5\.3-flash"/u);
    assert.match(flashBody, /"type":"image_url"/u);
    assert.match(flashBody, /data:image\/png;base64/u);

    for (const model of ["glm-5.3", "glm-5.2"] as const) {
      let textBody = "";
      const textOnly = createProvider(config, "glm", model, {
        loadImage: async () => {
          throw new Error(`${model} must not load image bytes`);
        },
        transport: async (request) => {
          textBody = request.body;
          return successResponse();
        },
      });
      await textOnly.complete({
        messages: [{ role: "user", content: "Historical image", images: [attachment] }],
      });
      assert.match(textBody, new RegExp(`${model} cannot receive images`, "u"));
      assert.doesNotMatch(textBody, /data:image/u);
    }
  });

  it("validates Qwen image constraints before loading bytes", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.qwen.apiKey = "test-key";
    let loaded = false;
    const provider = createProvider(config, "qwen", "qwen3-vl-plus", {
      loadImage: async () => {
        loaded = true;
        return PNG_1X1;
      },
      transport: async () => successResponse(),
    });
    const tiny: ImageAttachment = {
      id: "image_00000000-0000-4000-8000-000000000002",
      label: "Image #1",
      mediaType: "image/png",
      storageKey:
        "attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-000000000002.png",
      sha256: "2".repeat(64),
      byteSize: PNG_1X1.length,
      width: 1,
      height: 1,
    };

    await assert.rejects(
      provider.complete({ messages: [{ role: "user", content: "tiny", images: [tiny] }] }),
      /larger than 10x10/u,
    );
    await assert.rejects(
      provider.complete({
        messages: [{ role: "user", content: "tiny", images: [tiny] }],
        currentTurnImageIds: [tiny.id],
      }),
      /larger than 10x10/u,
    );
    assert.equal(loaded, false);
  });

  it("omits provider-incompatible historical images without mutating thread messages", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.qwen.apiKey = "test-key";
    const historicalGif: ImageAttachment = {
      id: "image_00000000-0000-4000-8000-000000000003",
      label: "Image #1",
      mediaType: "image/gif",
      storageKey:
        "attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-000000000003.gif",
      sha256: "3".repeat(64),
      byteSize: GIF_1X1.length,
      width: 16,
      height: 16,
    };
    const currentPng: ImageAttachment = {
      id: "image_00000000-0000-4000-8000-000000000004",
      label: "Image #2",
      mediaType: "image/png",
      storageKey:
        "attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-000000000004.png",
      sha256: "4".repeat(64),
      byteSize: PNG_16X16.length,
      width: 16,
      height: 16,
    };
    const historicalPrompt = "Earlier DeepSeek image [Image #1]";
    const messages: ChatMessage[] = [
      { role: "user", content: historicalPrompt, images: [historicalGif] },
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "Inspect the current [Image #2]", images: [currentPng] },
    ];
    const loadedIds: string[] = [];
    let body = "";
    const provider = createProvider(config, "qwen", "qwen3-vl-plus", {
      loadImage: async (attachment) => {
        loadedIds.push(attachment.id);
        return PNG_16X16;
      },
      transport: async (request) => {
        body = request.body;
        return successResponse();
      },
    });

    await provider.complete({
      messages,
      currentTurnImageIds: [currentPng.id],
    });

    assert.deepEqual(loadedIds, [currentPng.id]);
    assert.doesNotMatch(body, /data:image\/gif/u);
    assert.match(body, /data:image\/png;base64/u);
    const parsed = JSON.parse(body) as {
      messages: Array<{ content: string | Array<Record<string, unknown>> }>;
    };
    const historicalContent = parsed.messages[0]?.content;
    assert.equal(typeof historicalContent, "string");
    if (typeof historicalContent === "string") {
      assert.match(historicalContent, /Historical image attachment\(s\) omitted/u);
      assert.match(historicalContent, /Image #1 uses GIF/u);
      assert.match(historicalContent, /Local thread history is unchanged/u);
      assert.ok(historicalContent.length <= historicalPrompt.length + 2 + 600);
    }
    assert.equal(messages[0]?.role, "user");
    if (messages[0]?.role === "user") {
      assert.deepEqual(messages[0].images, [historicalGif]);
      assert.equal(messages[0].content, historicalPrompt);
    }
  });

  it("redacts image data URLs returned in model content and API errors", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.deepseek.apiKey = "test-key";
    const success = createProvider(config, "deepseek", "deepseek-v4-pro", {
      transport: async () => ({
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: "echo data:image/png;base64,QUJDRA== end",
            },
          }],
        }),
      }),
    });
    const response = await success.complete({
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(response.message.content, "echo [REDACTED_IMAGE_DATA_URL] end");

    const failure = createProvider(config, "deepseek", "deepseek-v4-pro", {
      transport: async () => ({
        statusCode: 400,
        headers: {},
        body: JSON.stringify({
          error: { message: "bad data:image/png;base64,QUJDRA== payload" },
        }),
      }),
    });
    await assert.rejects(
      failure.complete({ messages: [{ role: "user", content: "hello" }] }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /QUJDRA/u);
        assert.match(error.message, /REDACTED_IMAGE_DATA_URL/u);
        return true;
      },
    );
  });

  it("does not load historical images when the selected model is text-only", async () => {
    const config = createDefaultEasyCodeConfig(process.cwd());
    config.qwen.apiKey = "test-key";
    const attachment: ImageAttachment = {
      id: "image_00000000-0000-4000-8000-000000000000",
      label: "Image #1",
      mediaType: "image/png",
      storageKey:
        "attachments/00000000000000000000000000000000/image_00000000-0000-4000-8000-000000000000.png",
      sha256: "0".repeat(64),
      byteSize: PNG_1X1.length,
      width: 1,
      height: 1,
    };
    let serialized = "";
    const provider = createProvider(config, "qwen", "qwen3-max", {
      loadImage: async () => {
        throw new Error("text-only models must not load image bytes");
      },
      transport: async (request) => {
        serialized = request.body;
        return successResponse();
      },
    });

    await provider.complete({
      messages: [{ role: "user", content: "Earlier request", images: [attachment] }],
    });
    assert.match(serialized, /Image #1 omitted/u);
    assert.doesNotMatch(serialized, /data:image/u);
  });
});
