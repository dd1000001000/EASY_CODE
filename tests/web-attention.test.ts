import assert from "node:assert/strict";

import { notifyAttention, requestAttentionPermission } from "../src/web/attention.js";
import { describe, it } from "./harness.js";

interface FakeNotification {
  readonly title: string;
  readonly options: { readonly body: string; readonly tag: string };
  onclick: (() => void) | null;
  closed: boolean;
  close(): void;
}

/** Just enough of a browser page for the attention helper, restored after each case. */
function withPage(
  state: { visibility: "visible" | "hidden"; focused: boolean; permission: NotificationPermission },
  run: (page: {
    readonly shown: FakeNotification[];
    readonly requests: () => number;
    readonly fire: (event: "focus" | "visibilitychange") => void;
    readonly document: { title: string };
  }) => void,
): void {
  const global = globalThis as Record<string, unknown>;
  const saved = { window: global.window, document: global.document, Notification: global.Notification };
  const shown: FakeNotification[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const on = (event: string, listener: () => void) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(listener);
  };
  const off = (event: string, listener: () => void) => listeners.get(event)?.delete(listener);
  let requests = 0;
  class Notification {
    static get permission(): NotificationPermission {
      return state.permission;
    }
    static requestPermission(): Promise<NotificationPermission> {
      requests += 1;
      return Promise.resolve(state.permission);
    }
    onclick: (() => void) | null = null;
    closed = false;
    constructor(
      readonly title: string,
      readonly options: { body: string; tag: string },
    ) {
      shown.push(this as unknown as FakeNotification);
    }
    close(): void {
      this.closed = true;
    }
  }
  const document = {
    title: "EASY CODE",
    get visibilityState() {
      return state.visibility;
    },
    hasFocus: () => state.focused,
    addEventListener: on,
    removeEventListener: off,
  };
  global.window = { Notification, addEventListener: on, removeEventListener: off, focus: () => undefined };
  global.document = document;
  global.Notification = Notification;
  try {
    run({
      shown,
      requests: () => requests,
      fire: (event) => {
        for (const listener of [...(listeners.get(event) ?? [])]) listener();
      },
      document,
    });
  } finally {
    Object.assign(global, saved);
  }
}

describe("web attention notifications", () => {
  it("stays quiet while the page is visible and focused", () => {
    withPage({ visibility: "visible", focused: true, permission: "granted" }, ({ shown, document }) => {
      assert.equal(notifyAttention("Task finished", "turn-1"), false);
      assert.equal(shown.length, 0);
      assert.equal(document.title, "EASY CODE");
    });
  });

  it("shows a system notification and marks the tab while the user is away", () => {
    withPage({ visibility: "hidden", focused: false, permission: "granted" }, ({ shown, document }) => {
      assert.equal(notifyAttention("Task finished · took 1m 12s", "turn-1"), true);
      assert.equal(shown.length, 1);
      assert.equal(shown[0]?.title, "EASY CODE");
      assert.deepEqual(shown[0]?.options, { body: "Task finished · took 1m 12s", tag: "turn-1" });
      assert.equal(document.title, "● EASY CODE");
      // A second notice does not stack marks.
      notifyAttention("Approval needed", "decision-1");
      assert.equal(document.title, "● EASY CODE");
      shown[0]?.onclick?.();
      assert.equal(shown[0]?.closed, true);
    });
  });

  it("removes the tab mark when the user comes back", () => {
    const state = { visibility: "hidden" as "visible" | "hidden", focused: false, permission: "denied" as const };
    withPage(state, ({ shown, document, fire }) => {
      notifyAttention("Task finished", "turn-1");
      // Without permission only the title is marked.
      assert.equal(shown.length, 0);
      assert.equal(document.title, "● EASY CODE");
      state.visibility = "visible";
      state.focused = true;
      fire("visibilitychange");
      assert.equal(document.title, "EASY CODE");
    });
  });

  it("asks for permission only while the browser has not decided", () => {
    withPage({ visibility: "visible", focused: true, permission: "default" }, ({ requests }) => {
      requestAttentionPermission();
      assert.equal(requests(), 1);
    });
    withPage({ visibility: "visible", focused: true, permission: "denied" }, ({ requests }) => {
      requestAttentionPermission();
      assert.equal(requests(), 0);
    });
  });
});
