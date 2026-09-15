import { build } from "esbuild";
import { cpSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "Sources", "DirectoryApp", "Resources", "Preview");
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(here, "src", "renderer.js")],
  bundle: true,
  format: "iife",
  minify: true,
  outfile: join(out, "preview.js"),
});

copyFileSync(join(here, "src", "index.html"), join(out, "index.html"));
copyFileSync(join(here, "node_modules", "katex", "dist", "katex.min.css"), join(out, "katex.min.css"));

const fontsOut = join(out, "fonts");
mkdirSync(fontsOut, { recursive: true });
const fontsDir = join(here, "node_modules", "katex", "dist", "fonts");
for (const file of readdirSync(fontsDir)) {
  if (file.endsWith(".woff2")) copyFileSync(join(fontsDir, file), join(fontsOut, file));
}

console.log("preview assets written to", out);
