import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "./harness.js";

describe("public Web transport", () => {
  it("pins DNS results, checks redirects and IPv6, bounds decoded bodies, and observes cancellation", () => {
    const moduleUrl = new URL("../src/resources/web-content.js", import.meta.url).href;
    // Isolate builtin-module mocks from the other suites. Only this test server
    // receives traffic; the checked public addresses are inspected, not contacted.
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import http from "node:http";
      import dns from "node:dns/promises";
      import { syncBuiltinESMExports } from "node:module";
      import { gzipSync, brotliCompressSync, deflateSync } from "node:zlib";
      const server = http.createServer((request, response) => {
        const pathname = new URL(request.url, "http://test").pathname;
        if (pathname === "/redirect") {
          response.writeHead(302, { location: "/plain" });
          response.end("redirect");
        } else if (pathname === "/private") {
          response.writeHead(302, { location: "http://127.0.0.1/private" });
          response.end();
        } else if (pathname === "/loop") {
          response.writeHead(302, { location: "/loop" });
          response.end();
        } else if (pathname === "/gzip" || pathname === "/br" || pathname === "/deflate") {
          const encode = pathname === "/gzip" ? gzipSync : pathname === "/br" ? brotliCompressSync : deflateSync;
          const data = encode("x".repeat(500));
          response.writeHead(200, { "content-encoding": pathname.slice(1), "content-length": data.length });
          response.end(data);
        } else if (pathname === "/bad-gzip") {
          response.writeHead(200, { "content-encoding": "gzip" });
          response.end("broken compressed body");
        } else if (pathname === "/chunked") {
          response.write("a".repeat(32));
          response.end("b".repeat(32));
        } else if (pathname === "/truncated") {
          response.writeHead(200, { "content-length": "100" });
          response.write("short");
          setImmediate(() => response.destroy());
        } else if (pathname === "/slow") {
          response.write("waiting");
        } else {
          response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          response.end("hello");
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const origin = "http://127.0.0.1:" + server.address().port;
      let requests = 0;
      let resolutions = 0;
      dns.lookup = async (hostname) => {
        resolutions++;
        if (hostname === "slow-dns.example") return new Promise(() => {});
        if (hostname === "mixed.example") return [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }];
        return [{ address: "8.8.8.8", family: 4 }];
      };
      const originalRequest = http.request;
      http.request = (url, options, receive) => {
        requests++;
        assert.equal(options.agent, false);
        const ipv6 = url.hostname.startsWith("[");
        assert.equal(options.family, ipv6 ? 6 : 4);
        options.lookup(url.hostname, {}, (error, address, family) => {
          assert.equal(error, null);
          assert.equal(address, ipv6 ? "2001:4860:4860::8888" : "8.8.8.8");
          assert.equal(family, ipv6 ? 6 : 4);
        });
        return originalRequest(new URL(url.pathname + url.search, origin), {
          ...options, family: 4, lookup: undefined, headers: { ...options.headers, Host: url.host },
        }, receive);
      };
      syncBuiltinESMExports();
      const { fetchPublic } = await import(${JSON.stringify(moduleUrl)});
      try {
        const plain = await fetchPublic("http://allowed.example/plain");
        assert.equal(plain.data.toString(), "hello");
        assert.equal(plain.mediaType, "text/plain");
        assert.equal(resolutions, 1);
        const redirected = await fetchPublic("http://allowed.example/redirect");
        assert.equal(redirected.url, "http://allowed.example/plain");
        assert.equal(redirected.data.toString(), "hello");
        assert.equal((await fetchPublic("http://[2001:4860:4860::8888]/plain")).data.toString(), "hello");
        for (const encoding of ["gzip", "br", "deflate"]) {
          assert.equal((await fetchPublic("http://allowed.example/" + encoding)).data.length, 500);
          await assert.rejects(fetchPublic("http://allowed.example/" + encoding, { maxBytes: 40 }), /40-byte limit/);
        }
        await assert.rejects(fetchPublic("http://allowed.example/chunked", { maxBytes: 40 }), /40-byte limit/);
        await assert.rejects(fetchPublic("http://allowed.example/plain", { maxBytes: 4 }), /4-byte limit/);
        await assert.rejects(fetchPublic("http://allowed.example/bad-gzip"));
        await assert.rejects(fetchPublic("http://allowed.example/truncated"));
        const beforePrivate = requests;
        await assert.rejects(fetchPublic("http://allowed.example/private"), /Private or local/);
        assert.equal(requests, beforePrivate + 1);
        const forbidden = ["127.0.0.1", "10.0.0.1", "0.0.0.0", "169.254.1.1", "198.18.0.1", "[::]", "[::1]", "[::ffff:127.0.0.1]", "[fe81::1]", "[febf::1]", "[fc00::1]", "[ff02::1]", "[2002:7f00:1::]", "mixed.example"];
        const beforeForbidden = requests;
        for (const host of forbidden) await assert.rejects(fetchPublic("http://" + host + "/"), /Private or local/);
        assert.equal(requests, beforeForbidden);
        await assert.rejects(fetchPublic("http://user:password@allowed.example/"), /credentials/);
        await assert.rejects(fetchPublic("file:///tmp/file"), /Only HTTP/);
        await assert.rejects(fetchPublic("http://allowed.example/loop"), /too many/);
        for (const maxBytes of [0, -1, NaN, Infinity, 1.5]) await assert.rejects(fetchPublic("http://allowed.example/", { maxBytes }), /positive safe integer/);
        for (const endpoint of ["http://slow-dns.example/", "http://allowed.example/slow"]) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(new Error("cancelled")), 30);
          try { await assert.rejects(fetchPublic(endpoint, { signal: controller.signal })); }
          finally { clearTimeout(timer); }
        }
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    `,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
});
