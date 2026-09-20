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
  },
  server: { host: "127.0.0.1" },
});
