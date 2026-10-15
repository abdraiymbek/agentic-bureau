# Fixtures

Deterministic fixtures for tests, demos, and release verification.
Nothing here is live data: every source excerpt, offer price, and part
property is a **fixture-recorded** value — real parts with real published
figures, captured offline, never fetched at build time. Where a figure was
not published, the fixture labels it an _assumption_ (`needsValidation`).

Every builder takes a `FixtureCore` (`core.ts`): anything with the command
surface's `dispatch`. The fixtures are built on the Rust host, `omenflow-host`,
driven through the conformance client `tests/conformance/rust-core.ts` — the
same path the desktop app ships. The legacy TypeScript `CoreApp` fits the same
interface and `tests/golden-path.test.ts` still drives it.

## rover/

`rover.fixture.ts` builds the reference project — a small inspection rover
with a removable camera tray — through the host's command surface:

- requirements incl. the 300 g payload requirement (later changed to 500 g),
  architecture, assumptions, concept note
- recorded sources (manufacturer/supplier pages, marked fixture)
- component candidates for motors/driver/MCU/camera/battery/regulator,
  two motor candidates compared, selection through a reviewable proposal
- BOM lines tied to selected revisions + offers
- `camera-tray.scad` — a real parametric OpenSCAD source, attached to the
  part as its source file; it has a render only once a CAD tool renders it on
  a machine with OpenSCAD
- unit-aware calculations wired to requirement/component revisions:
  mass budget, power budget, battery energy, wheel torque
- wiring draft (pins + connections) and a validation run
- a test procedure linked to the payload requirement
- assembly steps

`drone-dependencies/` provides the payload→propulsion→endurance impact
fixture (requirement change propagates to endurance calc + prop selection).

## Building a fixture project on disk

```sh
pnpm fixture:rover /tmp/my-rover     # creates a real project dir
pnpm fixture:drone /tmp/my-drone
```

`fixtures/build.ts` builds the host, starts it on a temporary data folder,
builds the project and stops the host again. The same builders populate
`pnpm design:preview` and run against the host in
`tests/conformance/golden-path.conformance.ts`.
