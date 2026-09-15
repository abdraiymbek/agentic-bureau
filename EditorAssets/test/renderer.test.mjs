import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { buildSync } from "esbuild";

const dom = new JSDOM("<!DOCTYPE html><html><body><div id=\"preview\"></div></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
window.__DIRECTORY_TEST__ = true;

const mod = await import("../src/renderer.js");
const { renderHtml, taskLines, stripFrontmatter, mount, rewriteImages } = mod;

test("frontmatter is hidden", () => {
  const html = renderHtml("---\ntitle: X\ntags: [a]\n---\n# Hi\n\nbody\n");
  assert.ok(!html.includes("tags"));
  assert.ok(html.includes("Hi"));
  assert.ok(html.includes("body"));
  assert.equal(stripFrontmatter("---\nx: 1\n---\nok"), "ok");
});

test("wikilink renders wiki anchor with target", () => {
  const html = renderHtml("See [[Notes/Target|the target]] and [[Other]].\n");
  assert.match(html, /class="wiki"[^>]*data-target="Notes\/Target"/);
  assert.match(html, />the target<\/a>/);
  assert.match(html, /data-target="Other"/);
});

test("wikilink is not parsed inside fenced code", () => {
  const html = renderHtml("```\n[[NotALink]]\n```\n");
  assert.ok(!html.includes("class=\"wiki\""));
  assert.ok(html.includes("[[NotALink]]"));
});

test("gfm task list renders checkboxes and taskLines finds source lines", () => {
  const md = "# T\n\n- [ ] first\n- [x] second\n\n```\n- [ ] not a task\n```\n";
  const html = renderHtml(md);
  assert.equal((html.match(/type="checkbox"/g) || []).length, 2);
  assert.deepEqual(taskLines(md), [3, 4]);
});

test("math renders via katex and fails soft on bad input", () => {
  const html = renderHtml("Inline $x^2$ and display $$\\int_0^1 x$$.\n");
  assert.ok(html.includes("katex"));
});

test("math inside code is not rendered", () => {
  const html = renderHtml("`$x$` and\n\n```\n$$y$$\n```\n");
  assert.ok(!html.includes("katex"));
});

test("script injection is sanitized", () => {
  const html = renderHtml("hello <script>alert(1)</script> <img src=x onerror=alert(1)>\n");
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("onerror"));
});

test("click on wikilink posts openLink with decoded target", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const messages = [];
  const render = mount(container, { postMessage: (m) => messages.push(m) });
  render({ markdown: "[[Some/Note]]" });
  const anchor = container.querySelector("a.wiki");
  assert.ok(anchor);
  anchor.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(messages.at(-1), { type: "openLink", target: "Some/Note" });
  container.remove();
});

test("checkbox click posts toggleTask with correct line", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const messages = [];
  const render = mount(container, { postMessage: (m) => messages.push(m) });
  render({ markdown: "# A\n\n- [ ] one\n- [ ] two\n" });
  const boxes = container.querySelectorAll('input[type="checkbox"]');
  assert.equal(boxes.length, 2);
  boxes[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const msg = messages.at(-1);
  assert.equal(msg.type, "toggleTask");
  assert.equal(msg.line, 4);
  assert.equal(msg.checked, true);
  container.remove();
});

test("CRLF input is normalized before frontmatter and tasks", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const messages = [];
  const render = mount(container, { postMessage: (m) => messages.push(m) });
  render({ markdown: "---\r\ntitle: X\r\n---\r\n\r\n- [ ] t\r\n" });
  const boxes = container.querySelectorAll('input[type="checkbox"]');
  assert.equal(boxes.length, 1);
  boxes[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(messages.at(-1).line, 5);
  container.remove();
});

test("numbered, nested and blockquote tasks map to source lines", () => {
  const md = "- [ ] a\n  - [x] nested\n1. [ ] ordered\n> - [ ] quoted\n```\n- [ ] no\n```\n";
  assert.deepEqual(taskLines(md), [1, 2, 3, 4]);
});

test("raw HTML checkboxes are removed so they cannot toggle a wrong line", () => {
  const html = renderHtml('- [ ] real\n\n<input type="checkbox" onchange="x()">\n');
  assert.equal((html.match(/type="checkbox"/g) || []).length, 1);
  assert.ok(!html.includes("onchange"));
});

test("unmapped checkbox stays disabled and silent", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const messages = [];
  const render = mount(container, { postMessage: (m) => messages.push(m) });
  render({ markdown: "- [ ] one\n- [ ] two\n" });
  const extra = document.createElement("input");
  extra.type = "checkbox";
  container.appendChild(extra);
  render({ markdown: "- [ ] one\n- [ ] two\n\n" });
  const boxes = container.querySelectorAll('input[type="checkbox"]');
  assert.equal(boxes.length, 2);
  container.remove();
});

test("relative images resolve against the note folder, root maps inside workspace", () => {
  const container = document.createElement("div");
  container.innerHTML = '<img src="pic a.png"><img src="../Shared/b.png"><img src="/Attachments/c.png"><img src="https://evil.example/x.png" alt="tracker"><img src="../../esc.png">';
  rewriteImages(container, "Notes/Sub");
  const imgs = container.querySelectorAll("img");
  assert.equal(imgs[0].getAttribute("src"), "directory-asset://workspace/Notes/Sub/pic%20a.png");
  assert.equal(imgs[1].getAttribute("src"), "directory-asset://workspace/Notes/Shared/b.png");
  assert.equal(imgs[2].getAttribute("src"), "directory-asset://workspace/Attachments/c.png");
  assert.equal(imgs[3].getAttribute("src"), "directory-asset://workspace/esc.png");
  assert.equal(container.querySelectorAll("img").length, 4);
  assert.ok(container.textContent.includes("tracker"));
});

test("hidden components in image paths are rejected", () => {
  const container = document.createElement("div");
  container.innerHTML = '<img src="../.directory/drafts.json" alt="x">';
  rewriteImages(container, "Notes");
  assert.equal(container.querySelectorAll("img").length, 0);
});

test("relative markdown link posts openLink, external posts openExternal", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const messages = [];
  const render = mount(container, { postMessage: (m) => messages.push(m) });
  render({ markdown: "[Other](Other.md) [Web](https://example.com)\n" });
  const links = container.querySelectorAll("a");
  links[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  links[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(messages.at(-2), { type: "openLink", target: "Other.md" });
  assert.deepEqual(messages.at(-1), { type: "openExternal", url: "https://example.com" });
  container.remove();
});

test("real index.html defers preview.js and install() mounts after DOM ready", async () => {
  const html = readFileSync(new URL("../src/index.html", import.meta.url), "utf8");
  assert.match(html, /<script src="preview\.js" defer><\/script>/);
  const bundled = buildSync({
    entryPoints: [new URL("../src/renderer.js", import.meta.url).pathname],
    bundle: true,
    format: "iife",
    write: false,
  });
  const source = bundled.outputFiles[0].text;
  const page = new JSDOM(html, { runScripts: "outside-only" });
  page.window.eval(source);
  for (let i = 0; i < 50 && typeof page.window.directory !== "object"; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(typeof page.window.directory?.render, "function");
  page.window.directory.render({
    markdown: "# Heading\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] task\n\n$x^2$\n\n![p](pic.png)\n",
    basePath: "Notes",
  });
  const preview = page.window.document.getElementById("preview");
  assert.equal(preview.querySelector("h1")?.textContent, "Heading");
  assert.ok(preview.querySelector("table"));
  assert.ok(preview.querySelector("math, .katex"));
  assert.ok(preview.querySelector('input[type="checkbox"]'));
  assert.equal(preview.querySelector("img")?.getAttribute("src"), "directory-asset://workspace/Notes/pic.png");
});

test("render skips redraw when markdown unchanged but theme applies", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let count = 0;
  const render = mount(container, { postMessage: () => count++ });
  render({ markdown: "# A" });
  render({ markdown: "# A", theme: "dark" });
  assert.equal(count, 1);
  assert.equal(document.documentElement.style.getPropertyValue("--canvas"), "#202122");
  container.remove();
});
