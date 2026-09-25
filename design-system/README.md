# Omen Flow design resources — Lens

Start with [design.md](design.md). This folder is the canonical design system.

- [Gallery](index.html): the interaction model and captured screens.
- [Tokens](tokens.css): Graphite and Paper themes, type scale, spacing, geometry, motion.
- [Resource manifest](resources.json): brand, fonts, libraries, licences, and provenance.
- [Verification](verification.md): checks performed and their limits.
- `brand/`: the vector mark, black/white exports, the app icon source, and the supplied
  source artwork.
- `fonts/`: vendored Geist and IBM Plex Mono with licences, loaded locally.
- `screenshots/`: reference captures of the implemented renderer.
- `fixtures/`: the illustrative mesh used only by the disposable preview.

Run `pnpm design:preview`, then open [the gallery](http://127.0.0.1:5173/design-system/) or
[the workspace](http://127.0.0.1:5173/?design-preview). Useful preview parameters:
`screen=launcher|parts|timeline|files|decide|system`, `object=<type>`, `theme=light|dark`,
`console=open`. The in-app **Design system** view (launcher footer or `⌘K`) is the live
component catalogue.

Read root `AGENTS.md` before extending the interface. Update the specification, tokens,
primitives, catalogue, and reference screens together.
