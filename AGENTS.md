# Omen Flow agent instructions

## Product UI and design

Before creating or changing any user-facing surface, read [the Lens design specification](design-system/design.md). Use [the canonical tokens](design-system/tokens.css), vendored fonts, the brand mark (`Mark` / `design-system/brand/`), and the primitives in `apps/desktop/src/renderer/ui/kit.tsx`. The live **Design system** view is the component reference.

Preserve the Lens interaction model: three zoom levels (project flow and lenses → one object between its input and consequence rails → one decision), a left activity bar (Agent tab first), no dashboard, causal left-to-right layout, type-shaped stages, and the agent terminal (tab and floating window) wired to the real PTY. Keep the visual language: graphite field, islands for floating controls, Geist interface text, IBM Plex Mono values, Phosphor icons, one signal accent reserved for live and focused things, and labelled engineering state. Add a stage or a lens rather than a page. Follow the specification’s extension checklist and update the catalogue for new reusable patterns.

Preserve quantities and units, unknowns, evidence, revision history, and human review. Do not fabricate tool success, collaboration, production readiness, or data. Keep existing `@omenflow` APIs and `.omenflow` storage compatible unless the task explicitly includes migration.

Use `pnpm design:preview` for disposable populated design review and `pnpm dev` for native desktop validation. See `design-system/verification.md` for the latest checks and limits.

## Videos

`videos/` is a standalone npm package (not a pnpm workspace member) holding the launch trailer. `videos/trailer/` is a deterministic HTML composition: `render(t)` sets every property from time alone, using the canonical tokens, fonts, mark, Phosphor icons and Sable rover fixture data. Run `npm install` in `videos/`, then `npm run preview` (scrubbable, space to play) or `npm run render` (needs Homebrew `ffmpeg`; writes `videos/omen-flow-trailer.mp4`). `node scripts/render.mjs --draft` renders a quick 30 fps version to `out/`, and `--still 5.6,9.1 --still-dir /tmp/x` exports PNG frames for review. The soundtrack is synthesised by `scripts/audio.mjs` from the same timeline, so keep cue times in step when retiming scenes.

<!-- BEGIN SIMPLE-COMPUTER-USE -->

## Computer use — `scu` (simple-computer-use)

This machine has the `scu` CLI installed, giving you computer use: see the
screen, point at UI elements, click, type, scroll, drag, and open apps.

- Start of a GUI task: `scu session start` (orange glow + cursor badge show
  the user what you're doing). End with `scu session end`.
- Loop: `scu screenshot` -> read the PNG -> act -> `scu screenshot` to verify.
- Act on elements by description (`scu click "the Save button"`), by pixel
  (`scu click --at 840,512`), or by text (`scu find-text "Save"`).
- All output is JSON. Full reference: run `scu --help`, or read the bundled
  skill at /Users/abraiymbek/Library/Application Support/pipx/venvs/simple-computer-use/lib/python3.12/site-packages/scu/skills/computer-use/SKILL.md.

<!-- END SIMPLE-COMPUTER-USE -->
