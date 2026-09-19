/** Vite build for the QA harness only — does not touch the production build. */
import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

export default defineConfig({
  root,
  base: "./",
  build: {
    outDir: path.join(root, "dist-preview"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.join(root, "preview", "preview.html"),
    },
    minify: false, // readable bundles make console-error tracing easier
  },
});
