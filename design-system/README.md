# Omen Flow design resources — Lens

Start with [design.md](design.md). This folder is the canonical design system.

- [Gallery](index.html): the workbench, the visual language in both themes, and links that open
  each live screen on the preview project.
- [Tokens](tokens.css): Graphite and Paper roles, type scale and line heights, spacing, geometry,
  layers, depth, motion, and the terminal palette. Text roles meet WCAG AA on every surface;
  `tests/frontend/ui-tokens.test.ts` fails if a change breaks that.
- [Resource manifest](resources.json): brand, fonts, libraries, licences, and provenance.
- [Verification](verification.md): checks performed and their limits.
- `brand/`: the vector mark, black/white exports, the app icon source, and the supplied
  source artwork.
- `fonts/`: vendored Geist and IBM Plex Mono with licences, loaded locally.
- `screenshots/`: earlier reference captures. They predate the activity bar and are kept as
  history; the live catalogue and the gallery links show the current interface.
- `fixtures/`: the illustrative mesh used only by the disposable preview.

Run `pnpm design:preview` (set `OMEN_PREVIEW_PORT` to use a port other than 5173), then open
[the gallery](http://127.0.0.1:5173/design-system/) or
[the workspace](http://127.0.0.1:5173/?design-preview). The preview is the real renderer on the
Rust headless host (`omenflow-host`) with disposable rover and drone projects; its Agent tab runs
a real terminal (a Custom CLI, or Codex CLI and Claude Code when started with
`OMEN_PREVIEW_AGENTS=1`). Preview parameters:
`screen=launcher|agent|flow|parts|timeline|files|evidence|decide|system`, `object=<artifact type>`,
`theme=light|dark`, `console=open` (opens the agent window).

The in-app **Design system** view (launcher footer or `⌘K`, or `screen=system`) is the live
component reference: every primitive rendered from the real component in Graphite and Paper side
by side, each control in its rest, hover, focus, pressed, disabled and busy states, the state
vocabulary, the value formatters, measured contrast, and the geometry, depth and motion tokens
with playable motion utilities.

Read root `AGENTS.md` before extending the interface. Update the specification, tokens,
primitives, catalogue, and reference screens together.
