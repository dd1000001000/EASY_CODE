"use strict";

// npm run build && node scripts/benchmark-tui.cjs
// Local CPU-only benchmark: no provider requests, terminal writes or task data.
const { performance } = require("node:perf_hooks");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

async function main() {
  const view = await import(pathToFileURL(path.join(__dirname, "../dist/ui/tui/disclosure-view.js")).href);
  const { FullScreenWriter } = await import(pathToFileURL(path.join(__dirname, "../dist/ui/tui/full-screen-writer.js")).href);
  const body = "source code: const value = compute(input); 验证失败，需要继续调查。\n".repeat(20);
  const median = (run) => {
    const samples = [];
    for (let index = 0; index < 5; index += 1) {
      const start = performance.now();
      run();
      samples.push(performance.now() - start);
    }
    return Number(samples.sort((left, right) => left - right)[2].toFixed(3));
  };
  const results = [];
  for (const count of [20, 100, 500]) {
    const started = performance.now();
    let state = view.createDisclosureViewState({
      nodes: Array.from({ length: count }, (_, index) => ({ id: String(index), kind: "text", text: body })),
      columns: 120, rows: 40,
      headerLines: ["header"], composerLines: ["Request >"], footerLines: ["status"],
    });
    const initialMs = Number((performance.now() - started).toFixed(3));
    const output = { isTTY: true, columns: 120, rows: 40, write: () => true };
    const writer = new FullScreenWriter(output);
    writer.enter();
    writer.render(view.renderDisclosureView(state).rows);
    const scroll = () => {
      state = view.scrollDisclosureView(state, -1);
      state = view.updateDisclosureViewChrome(state, { headerLines: ["header"], composerLines: ["Request >"] });
      return view.renderDisclosureView(state);
    };
    results.push({
      nodes: count, characters: count * body.length, initialMs,
      renderMs: median(() => view.renderDisclosureView(state)),
      scrollRefreshMs: median(scroll),
      idleRefreshMs: median(() => {
        state = view.updateDisclosureViewChrome(state, { headerLines: ["header"], composerLines: ["Request >"] });
        view.renderDisclosureView(state);
      }),
      scrollWithWriterMs: median(() => writer.render(scroll().rows)),
    });
    writer.close();
  }
  console.table(results);
  console.log("Warm medians in milliseconds; writer uses a no-op sink, not a real terminal FPS measurement.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
