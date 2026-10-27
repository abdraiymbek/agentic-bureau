# Omen Flow — use-case showcase

**One sentence in. A connected engineering record out.** 38.0 s · 1920×1080 · 60 fps (120 fps
sub-frames blended for motion blur) · 120 BPM from the moment the prompt is sent · every frame a
pure function of time.

One real task, start to finish, in the real window: a person types one sentence, Claude Code builds
a survey quadcopter project in front of them, and nothing becomes the baseline until they approve
it. The direction borrows a typed prompt and close camera from the Calesto and Polar demos, and a
labelled, layer-by-layer build from the Salio terrain film.

## How it is made

- **The window is the renderer.** `index.html` links `design-system/tokens.css`, the vendored fonts
  and `apps/desktop/src/renderer/styles/index.css`, and `showcase.js` writes the app's own markup
  and class names (titlebar, activity bar, session bar, conversation, inline cards, Flow map, Needs
  you, docked agent window). `showcase.css` only frames it, and every name in it starts with `sc-`.
  A restyle of the app shows up here on the next render.
- **Nothing runs on the browser's clock.** All transitions and animations inside the stage are
  disabled; the spinner, pulse, caret, scrolling and card growth are set from `t`.
- **One cue sheet.** `cues.js` holds the prompt, the typing rhythm, the ledger rows, every object's
  arrival and the click times. The picture and `scripts/showcase-audio.mjs` both read it, so a
  retimed beat moves its sound.
- **Positions are measured, not typed.** At boot the film sets the window to each moment it needs
  and measures the composer, buttons, cards and the map, so the camera and cursor follow the real
  layout.
- **The part is drawn from its parameters.** `mount.js` builds the sensor head mount in three.js
  from the same numbers the card shows (92 × 64 × 3 mm plate, four Ø3.2 mm holes, cable slot, two
  38 mm yokes with Ø8 mm pivots).

## Beats

| Time        | Beat     | On screen                                                                                                          |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| 0.0 – 1.0   | Arrive   | The window tilts flat on the graphite field: the Agent tab, “What are we making?”                                   |
| 1.0 – 5.3   | Ask      | Push into the composer. “One sentence.” The prompt is typed; Send.                                                  |
| 5.3 – 7.5   | Start    | The turn appears, Claude Code responds, the activity rail fills with recorded calls.                                |
| 7.5 – 8.3   | Flow     | Click Flow: the empty project's four layers, the agent docked to the right.                                         |
| 8.3 – 12.3  | 01 Intent   | Three requirements and one assumption arrive with the agent's ring.                                              |
| 12.3 – 16.3 | 02 Parts    | Six sources, then six components, each linked to its source.                                                     |
| 16.3 – 22.3 | 03 Design   | Architecture, hinge, mount, wiring, assembly; Show 3D renders the mount in the conversation.                      |
| 22.3 – 26.3 | 04 Evidence | Mass budget, thrust-to-weight, hover endurance (22.4 min), hover test with no result yet.                        |
| 26.3 – 29.4 | Whole    | Pull back: 25 objects, 31 links; a proposal arrives; hovering Payload capacity lights its thread.                   |
| 29.4 – 33.3 | Decide   | Tick “I reviewed…”, Approve baseline, Confirm approval: Approved, no-baseline marks clear. “Agents propose. You decide.” |
| 33.3 – 38.0 | End      | The window tips back and fades; mark, “Omen Flow”, “One sentence in. A connected engineering record out.”         |

## The project

Survey quadcopter: a folding survey quad that carries a 300 g sensor head for 20 minutes.

- **Intent:** Payload capacity (0.3 kg), Flight time, Folded length; assumption Hover power per kg.
- **Parts:** Holybro Pixhawk 6C, Holybro M10 GPS, T-Motor MN3508 KV700, Tekko32 F4 4in1 50A ESC,
  LiPo 4S 6000 mAh pack, Holybro SiK Radio V3 — each a source and a component.
- **Design:** System architecture, Folding arm hinge, Sensor head mount, Power + signal wiring,
  Airframe assembly.
- **Evidence:** Takeoff mass budget, Thrust-to-weight at takeoff, Hover endurance, Hover test with
  payload.

The numbers agree with each other: 4S × 6.0 Ah = 88.8 Wh, 80 % usable = 71.0 Wh; 1.9 kg at
100 W/kg hovers at 190 W; 71.0 Wh / 190 W = 0.374 h = 22.4 min. The endurance stays an estimate
until the hover test records a result, and the film says so.

**This is an illustrative project, not a recorded run.** The parts are real products, but no
supplier figures are quoted, the mesh is drawn by three.js rather than rendered by OpenSCAD, and
the “Checks: passed” state is staged. Keep it labelled as a product demonstration wherever it is
published.

## Run

```sh
cd videos
npm install
node scripts/serve.mjs                         # then open /videos/showcase/ (space plays, arrows step)
node scripts/render-showcase.mjs               # final → videos/omen-flow-showcase.mp4
node scripts/render-showcase.mjs --draft       # 30 fps → out/omen-flow-showcase-draft.mp4
node scripts/render-showcase.mjs --still 9.8,20.8 --still-dir /tmp/x
node scripts/showcase-audio.mjs                # soundtrack only → out/showcase-audio.wav
```

The preview plays `out/showcase-audio.wav`; render or run the audio script once first. Rendering
needs Homebrew `ffmpeg`.
