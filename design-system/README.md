# Omen Flow design resources

Start with [design.md](design.md). This folder is the canonical design system.

- [Presentation](index.html): captured product walkthrough with links into the live workspace.
- [Tokens](tokens.css): shared dark/light colors, typography, spacing, density, and motion.
- [Resource manifest](resources.json): brand, fonts, libraries, licenses, and provenance.
- [Verification](verification.md): checks performed and native/release limits.
- `brand/`: original Omen Flow vector symbol.
- `fonts/`: vendored interface/technical fonts and licenses, loaded locally.
- `screenshots/`: reference captures from the implemented renderer.
- `fixtures/`: illustrative mesh generator, used only by the disposable preview.

Run `pnpm design:preview`, then open [the presentation](http://127.0.0.1:5173/design-system/) or [the workspace](http://127.0.0.1:5173/?design-preview). The in-app Design system page is an interactive component catalog built from the real application primitives.

Read root `AGENTS.md` before extending the interface. Update this specification, tokens, reusable components, and reference specimens together.
