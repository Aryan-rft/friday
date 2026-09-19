/** Inline built JS/CSS into one self-contained HTML for register_preview. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist-preview");
const src = path.join(dist, "preview", "preview.html");
const out = path.join(dist, "qa.html");

let html = fs.readFileSync(src, "utf8");

const htmlDir = path.dirname(src);

// Inline stylesheets (tag shape may vary — match on href ending in .css).
html = html.replace(/<link[^>]+href="([^"]+\.css)"[^>]*>/g, (_m, href) => {
  const css = fs.readFileSync(path.resolve(htmlDir, href), "utf8");
  return `<style>\n${css}\n</style>`;
});

// Inline module scripts (match on src ending in .js).
html = html.replace(/<script[^>]+src="([^"]+\.js)"[^>]*><\/script>/g, (_m, srcPath) => {
  const js = fs.readFileSync(path.resolve(htmlDir, srcPath), "utf8");
  return `<script type="module">\n${js}\n</script>`;
});

fs.writeFileSync(out, html);
console.log(`qa.html written: ${(fs.statSync(out).size / 1024).toFixed(1)} kB`);
