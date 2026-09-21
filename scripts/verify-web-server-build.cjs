"use strict";

// The server runs from dist/, while src/web is bundled separately by Vite.
// Import the production server entry to catch accidental runtime imports of
// browser-only source modules that TypeScript can resolve but does not emit.
import("../dist/web-server/server.js")
  .then(() => { process.stdout.write("EASY CODE: Web server module graph verified.\n"); })
  .catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
