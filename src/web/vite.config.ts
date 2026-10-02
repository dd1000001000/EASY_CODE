import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root,
  plugins: [vue()],
  build: {
    outDir: path.resolve(root, "../../dist/web"),
    emptyOutDir: true,
    // The largest chunks are the lazily loaded Shiki WASM engine and C++ grammar.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Libraries change less often than the app, so browsers keep them cached across updates.
        manualChunks: {
          vue: ["vue"],
          "element-plus": ["element-plus", "@element-plus/icons-vue"],
          markdown: ["markdown-it"],
        },
      },
    },
  },
  server: { host: "127.0.0.1" },
});
