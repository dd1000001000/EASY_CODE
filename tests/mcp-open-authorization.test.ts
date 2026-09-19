import assert from "node:assert/strict";
import { authorizationOpenCommand } from "../src/mcp/open-authorization.js";
import { describe, it } from "./harness.js";

describe("MCP authorization URL opening", () => {
  it("passes the URL as one argument to a fixed platform opener without a shell", () => {
    const url = "https://robinhood.com/oauth?state=one%26two&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback";
    assert.deepEqual(authorizationOpenCommand(url, "win32", "C:\\Windows"), {
      program: "C:\\Windows\\System32\\rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
    assert.deepEqual(authorizationOpenCommand(url, "darwin"), {
      program: "/usr/bin/open", args: [url],
    });
    assert.deepEqual(authorizationOpenCommand(url, "linux"), {
      program: "/usr/bin/xdg-open", args: [url],
    });
  });

  it("rejects executable, file, and non-loopback HTTP links", () => {
    for (const url of ["file:///tmp/app", "javascript:alert(1)", "custom-app://authorize",
      "http://example.com/authorize"]) {
      assert.throws(() => authorizationOpenCommand(url, "win32"), /HTTPS or loopback HTTP/u);
    }
  });
});
