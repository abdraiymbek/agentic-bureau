# Omen Flow — launch film

**Agents propose. People decide.** 29.0 s · 120 BPM (beat 0.5 s, bar 2 s) · 1920×1080 and 1080×1920 · every
pixel procedural (HTML/CSS/SVG/Canvas/three.js), every frame a pure function of time.

The cut fuses three directions from a storyboard panel scored by three judges: **One Thread** (a
single hairline runs through every shot at the same height, so hard cuts read as match cuts — the
spine), **Machine first** (the Sable rover as point clouds under raking light and an exploded view
stands in for the reference's footage, and bookends the film), and the reference's devices
(phrase-per-plate type, scattered tiles, a breath before a Paper title, a split decision, snapping
lines, a long silent lockup).

## Global system

**The thread.** One horizontal hairline, 1.5 px, at y = 540 (16:9) / 960 (9:16): `lib/film.js`
(`threadY`, `createThread`). It recurs in a different role in most shots: born from the raking light,
fractured into stubs, the terminal's baseline, the Payload capacity row of the map, the lit thread,
the values' baseline, the decision bar's top edge, the amber impact path, the hero phrase's
underline, the convergence line. White `#ededee` when idle, signal `#cff36e` only while the map's
thread is lit, amber `#f1bb68` only on the recorded impact path, ink `#141518` on Paper.

**Colour.** Graphite field `#0b0c0e`, surface `#111214`, raised `#17181b`; text `#ededee` /
`#a4a7ae` / `#848890`, idle marks `#64676f`. **Signal** only for live and focused things: the live
agent dot and terminal cursor, the agent-touch ring on objects the agent just drafted, the lit thread,
the focus ring on Approve. Primary buttons stay neutral (`#f1f1f2`); never fill a button with signal.
**Amber** only on the recorded impact path and always beside the words "Out of date". **Paper**
(`#ebecee` / `#f6f6f7`, ink `#141518` / `#474b53` / `#656972`) exactly three times, never back to back:
the title (8.0), the decision split (12.5), "people decide." (20.0).

**Lens grammar.** Causal links are solid and end in an open chevron at the consequence end. Dashed
means related (not causal) — do not use dashes for causality or for "proposed". A proposal is marked
with the branch icon and "In review". Space follows causality: inputs left, consequences right, in
9:16 too.

**Type.** Geist 500/600, lowercase phrases, tracking −0.032em, ≤ 6 words on screen at once (except the
end card). IBM Plex Mono for every value, unit, path, command; units in `#848890`. Reveals from
`lib/type.js`: `rise` (mask), `blur` (lens finding focus), `dim` (grey → white). Headline slot
(`lib/film.js headline`): 16:9 x 160 / baseline 230 / 96 px; 9:16 x 80 / baseline 360 / 108 px. Every
phrase holds ≥ 0.6 s after it is fully revealed. One focal read per shot.

**Brand.** The mark is never animated, stretched, rotated, outlined or tinted: it only appears (cut).
Wordmark: "Omen" 600, "Flow" 400 secondary. Clear space ≥ half the mark's width.

**Truth.** Every value is fixture data with its unit (`fixtures/rover`, `fixtures/drone-dependencies`,
`scripts/design-preview.ts`). Unknowns stay "Unknown"; assumptions say "assumption". The proposal is
"Increase payload capacity to 500 g": Payload capacity target 0.3 kg → 0.5 kg, r1 → r2, rationale
"Evaluate a heavier sensor package.". Approval copy is the app's own
(`apps/desktop/src/renderer/intro/DecideAct.tsx`): "Approved as the new baseline. Four dependents are
marked out of date. Approval does not mean validated." and "Approval updates the baseline and marks
dependents for revisiting. It does not mean the design is validated or fit to build." The map shows only the fixture's 17 recorded links (`lib/flowmap.js`): the ramp test validates Payload capacity directly, so the stale path is payload→tray, payload→mass, payload→ramp, then mass→torque; long links route through the gaps between rows, clear of type-group labels. Dependents show "Out of
date", never recomputed values; nothing passes or fails; the rover never drives the ramp after
approval. Quantities change atomically (never tween 0.3 → 0.5). No "ok" or success marks on agent
calls. Agent CLI names as plain mono text only. No "validated", invented users, partners or stats.

**Finish.** Grain and vignette come from the engine (`launch.js`); scenes add flashes through an
optional `fx(t)` on the scene object. Motion blur comes from the renderer: 4 sub-frames per 60 fps frame (240 fps, a 360° shutter), each
output frame blending the sub-frames that start at its own time, so hard cuts stay clean. Keep fast
moves under ~30 px per 1/120 s so they read as blur, not copies; never per-frame CSS blur on
full-frame layers (pre-blur, or blur small layers only).

## Shots

| # | Time | Scene file | Copy |
|---|------|-----------|------|
| 1 | 0.0–1.5 | `open.js` | every machine you build |
| 2 | 1.5–3.0 | `open.js` | lives in pieces |
| 3 | 3.0–4.5 | `pieces.js` | none of it · connects |
| 4 | 4.5–6.0 | `pieces.js` | your agent drafts it all |
| 5 | 6.0–7.5 | `snap.js` | into one record |
| 6 | 7.5–8.0 | `snap.js` | (breath) |
| 7 | 8.0–9.5 | `title.js` | Omen Flow (Paper) |
| 8 | 9.5–11.0 | `lens.js` | every change has a path. |
| 9 | 11.0–12.5 | `lens.js` | shaped like the work. |
| 10 | 12.5–14.0 | `decide.js` | (the proposal, Paper split) |
| 11 | 14.0–16.5 | `decide.js` | nothing becomes the baseline · until you approve. |
| 12 | 16.5–18.0 | `impact.js` | (Out of date ×4) |
| 13 | 18.0–19.0 | `impact.js` | (the ramp test, Out of date) |
| 14 | 19.0–20.0 | `hero.js` | agents propose. |
| 15 | 20.0–22.5 | `hero.js` | people decide. (Paper) |
| 16 | 22.5–24.0 | `converge.js` | (the machine, whole, collapses into a point) |
| 17 | 24.0–29.0 | `end.js` | lockup |

Big hits land on bar downbeats: 0.0 (open), 8.0 (title), 16.0 (approve), 20.0 (apex), 24.0 (logo).

### 1 · every machine you build — 0.0–1.5 (`open.js`)
Graphite. Frame 0 is already lit: an extreme macro of the Sable rover point cloud (`lib/roverStage.js`;
build a denser cloud for this shot, e.g. `pointsPerMm2` ≈ 0.6, bokeh capped ≈ 24 px) — the left 60 mm
wheel and its gearmotor fill the right two-thirds, the chassis melting into bokeh behind. A raking
light plane is mid-sweep at frame 0 and travels along +X (0.0–1.2); points in its band flare white,
behind it they keep a ~15 % afterglow, unreached points sit near 6 %. Focus racks from tread to hub
(0.3–1.1). Camera dollies in slightly and orbits +8°. Copy Geist 500 72 px, left x 160, baseline at 56 %
height: "every machine" at 0.4, "you build" at 0.75 (`blur`, 0.16 s/word). Micro label top-left,
Plex Mono 15 px `#848890`, from 0.2: "sable inspection rover". 1.0–1.5: the light leaves the rover as
the thread's head and runs right along the thread's y, leaving the hairline (reaches the right edge at
1.5). 9:16: wheel fills the lower 60 %, light sweeps bottom→top, copy top third at x 80, 84 px; head
then runs along y = 960. Sound: hit + air on frame 0, D1 sub swell, glass ticks on the words, low hit
at 1.5.

### 2 · lives in pieces — 1.5–3.0 (`open.js`)
Hard cut on the hit. The whole rover in a ¾ hero view (points + ~40 % edges, rim-lit), assembled for 2
frames, then exploding (1.5–2.4, expoOut): tray up, battery down, wheels out, boards up, camera
forward; a little dust drifts off. Leaders (1 px `#848890`) and Plex Mono 15 px labels (names `#a4a7ae`,
values `#ededee`) draw from 1.9 with 60 ms stagger — at most four: "Camera tray · 62 × 44 mm",
"LiPo 2S 450 mAh", "Raspberry Pi Zero 2 W · avg current Unknown", "Wheel · r 0.03 m · assumption".
Copy "lives in pieces", Geist 600 96 px, cut in at 1.5 (scale 1.04→1), centred at 82 % height. The
thread fractures into ~14 drifting segments at 1.5 and fades by 2.2. Push 4 %, yaw 6°. 9:16: explode
runs vertically (tray top … battery bottom, wheels to the sides), labels alternate sides, copy at 80 %.
Sound: heavy hit (sub kick + noise into a long plate), metal shards panned with parts.

### 3 · none of it connects — 3.0–4.5 (`pieces.js`)
Graphite with a sparse lattice of disconnected link stubs (48 px hairlines at ~10 %, each with an open
chevron, seeded directions, slowly rotating): causality with no order. Six raised islands (`#17181b`,
radius 15, 1 px line-strong, float shadow, ~240×68) pop in on 8ths from 3.0 (scale 0.96→1, 0.12 s, no
bounce): Phosphor icon + label (Geist 500 19 px) + value (Plex Mono 14 px `#848890`):
**Requirements** list-checks "0.3 kg" · **Parts** package "DRV8835" · **Mechanical** cube "62 × 44 mm" ·
**Calculations** calculator "7.4 V × 0.45 Ah" · **Electronics** circuitry "5 V" · **Tests** flask "15° ramp" (the app's type names). Three islands are lit on the 3.0 cut; the rest pop at 3.25, 3.5, 3.75.
One island nearer (scale 1.2, small blur), one farther (0.8); each drifts 8–18 px/s. Split phrase like
the reference: "none of it" left (x 160) at 3.5, "connects" right-aligned (right edge W−160) at 3.75,
Geist 500 60 px `#ededee`, same baseline (the thread's y). 9:16: islands in a loose two-column scatter
over the full height; "none of it" upper-left, "connects" lower-right. Sound: hit at 3.0, a glassy
pluck per island panned by x, the kick drops out.

### 4 · your agent drafts it all — 4.5–6.0 (`pieces.js`)
Inside the agent terminal: full-bleed inset well `#0d0e10`. Session bar at top (1.5× scale): live dot
`#cff36e` (breathing), "Agent" Geist 500, "Terminal" chip, path `~/sable-inspection-rover` in mono.
Macro teleprompter in Plex Mono 52 px: the cursor block (signal) sits on the thread (the text
baseline) at x ≈ 62 % of W; text streams left past it. The agent CLI (`claude`, plain text in the session bar) is already running; the prompt types at 120 chars/s from 4.625: "Build a compact inspection rover with a removable camera tray." Enter at 5.25 commits it (the cursor holds on the Enter frame, the return is a cut at 5.267, and the sent request wraps onto two dimmed lines above a fresh prompt). Only then do the call rows rise in the rail (5.375, 5.5, 5.625; tool id over an object chip, no "ok"): `artifact.create_draft` Payload capacity · `calculation.run` Rover mass budget · `test.create_draft` Ramp traverse with payload. Copy "your agent drafts it all" in the headline slot (96 / 108 px), `rise` from 4.5. Push 1.0→1.04. 9:16: copy two lines at top, teleprompter on y = 960 at
44 px, rail below (y 1100–1500). Sound: kick returns on every beat from 4.5, key ticks per character, a
soft tock per call row, riser from 5.5.

### 5 · into one record — 6.0–7.5 (`snap.js`)
The film's signature move (`lib/lines.js`). On the cut, ~200 short white segments (≈56×2 px) at
random angles occupy where the terminal's text and rows were. A wavefront sweeps left→right (6.0–7.0,
expoInOut): ahead of it segments jitter; behind it each rotates to 0° or 90° (slight overshoot) and
slides into its slot, building the **Sable Flow map skeleton** (`lib/flowmap.js` layout: Intent →
Parts (sources, components) → Design → Evidence). Each node outline is four segments; when all four
land the node resolves into a real map node (`lib/flowmapView.js`), glyph and title fading in, wearing
the soft signal agent-touch ring (the agent drafted it) that relaxes over ~0.6 s; column heads appear
(Intent 3 · Parts 14 · Design 4 · Evidence 5); links draw column by column ending in open chevrons. The
thread becomes the Payload capacity row. Copy "into one record" Geist 600 88 px bottom-left (x 160,
baseline H−120), `rise` at 6.25. 6.9–7.5: the camera eases into a 3D tilt (rotateX 0→22°, rotateZ −4°).
9:16: map at ~0.62 scale centred at y ≈ 900, wave crosses 1080 px; copy two lines low. Sound: a
granular rush of micro-clicks rising with x, lock thump at 7.0, riser.

### 6 · breath — 7.5–8.0 (`snap.js`)
Everything dims to ~20 % except the thread (the Payload capacity row), which holds, then settles to
40 % by 7.9. Music cuts to near silence with an inhale into 8.0.

### 7 · Omen Flow — 8.0–9.5 (`title.js`, built)
Paper. The wordmark is there on the cut frame (the hit is the reveal), Geist 220 px: "Omen" ink 600,
"Flow" `#474b53` 400, over ~76 solid causal hairlines that pinch into a band left of the name and fan
out to the right, ending in staggered chevrons, with light pulses travelling along them toward consequence and a feathered clear space around the name. The ink thread lies on the thread's y, under the name's baseline. Push 3.5 %. Sound: THE hit — sub drop, wide transient, pad bloom; groove creeps
back at 9.0.

### 8 · every change has a path. — 9.5–11.0 (`lens.js`)
The full Flow map (`flowmapView`) in 3D (perspective 1800, rotateX ≈ 26°, rotateY ≈ −12°), columns
receding right; Hover lights the thread at 10.0 exactly as the product does: one head leaves Payload capacity and forks along the routed links to Camera tray (10.125), Rover mass budget (10.25) and Ramp traverse with payload (10.5), while a second runs Rover mass budget → Wheel torque at 15° incline (10.375); pulses after; everything else at 28 %. Truck right along the thread, slight crane. Headline "every
change has a path." `rise` at 9.5. 9:16: headline top, map at ~0.62 in the middle band, peek strip below
in Plex Mono 30 px "Payload capacity · requirement · 0.3 kg". Sound: full groove, glass shimmer as the
thread lights, a tick per node reached.

### 9 · shaped like the work. — 11.0–12.5 (`lens.js`)
Headline "shaped like the work." holds still across one hard cut (type stays, plate changes). Level 1
composition at ~1.5×: left rail "Depends on", centre stage (surface, radius 20, 1 px border), right
rail "Affects"; connector lines from rail rows into the stage at the thread's y. (a) 11.0–11.75
Requirement "Payload capacity": statement "The rover shall carry a removable payload pack without loss
of mobility." and target "0.3 kg" (Plex Mono 64 px, unit dimmed). Depends on: "No recorded inputs." (the app's empty state). Affects 3: Camera tray, Rover mass budget, Ramp traverse with payload. (b) 11.75–12.5 Part
"Camera tray" in three.js (the tray part of `lib/rover.js` or `trailer/tray.js` geometry): graphite
faces + white edges, rim light, the app's "Illustrative mesh" pill, callouts "62 mm", "44 mm", "2.5 mm plate", "12 mm wall height"; 18° orbit,
rack focus from a near callout to the tray. Depends on: Payload capacity, Raspberry Pi Camera Module 3
Wide. Affects: "Nothing depends on this yet." (true in the record). 9:16: stage full width in the
middle, depends-on chips above entering from the left, affects below leaving right. Sound: tom hits on
11.0 and 11.75, sub swell under the tray.

### 10 · the proposal — 12.5–14.0 (`decide.js`)
Paper / graphite split (the reference's split-screen). Left 56 % Paper, right graphite with the rover
point cloud ¾ on a slow turntable, rim-lit (no signal on it). Paper half, no headline: macro Plex Mono
500 at ~150 px on the thread as baseline. "0.3 kg" solid ink, label "Baseline · r1". At 13.0 "0.5 kg"
arrives HOLLOW (1.5 px ink outline, no fill) on the line below, label "Proposed by the agent · r2" with the
"In review" pill and branch glyph. The value never tweens. Caption Plex Mono 18 px `#656972`:
"Increase payload capacity to 500 g" with the requirement glyph. 13.4–13.9: focus racks from the
hollow 0.5 kg to the solid baseline, which stays sharp and unchanged. 9:16: split horizontal (Paper top
62 %, graphite bottom). Sound: groove thins to kick + hat, a scratch tick as the hollow value lands,
focus whoosh at 13.4.

### 11 · nothing becomes the baseline / until you approve. — 14.0–16.5 (`decide.js`)
Graphite. Macro on the Decision level's bar (≈3.3× in 16:9, 2.4× in 9:16) pinned low, its top edge on the thread. The reviewer's rationale field shows the app's placeholder, then "Reject" (ghost), "Request changes" (secondary),
"Approve changes" (primary neutral `#f1f1f2`, ink, kbd ⌘↵). Blurred above (pre-blurred): the right
rail "Would affect 4" — Camera tray, Rover mass budget, Wheel torque at 15° incline, Ramp traverse with
payload — and "What approval means": "Approval updates the baseline and marks dependents for
revisiting. It does not mean the design is validated or fit to build." Copy: "nothing becomes the
baseline" (headline slot, 96 / 108 px, `rise` at 14.0, held to 14.88), replaced in place at 15.0 by "until you approve.". 15.375: the focus ring draws round Approve (2 px signal, 2 px offset) — the only signal on screen.
15.5–15.94: ⌘↵ keycaps press down. **16.0 (bar downbeat): the press** — button scale 0.97, a bloom on the button (no full-frame flash), a small shake; the notice opens 16.04–16.20 and "Approved as the new baseline." reads at full strength from 16.12, with the app's "Four dependents are marked out of date. Approval does not mean validated." as a secondary line. Slow push toward the button 14.0→16.0. 9:16: headline top,
blurred rail middle, buttons in one row at 1.6× low. Sound: tension roll of 16ths 15.5–15.94, an 8th of
silence, then the press: click + sub + chord lifting minor → major.

### 12 · Out of date — 16.5–18.0 (`impact.js`)
A macro slice of the map along the thread at ~2.2×: Payload capacity (now "r2 · baseline" in
`#848890`) → Camera tray and Rover mass budget → Wheel torque at 15° incline → Ramp traverse with
payload. The impact travels the recorded links outward on the beat (amber 2 px with a bright head):
payload→tray and payload→mass 16.5–16.75 (labels at 16.75), the long reach payload→ramp 17.0–17.25 (17.25), then mass→torque 17.5–17.75 (17.75). Each reached node: amber border, dot and "Out of date" (Geist 500,
amber). One continuous truck right (kept under ~30 px per 1/120 s so it blurs cleanly), then a push into the match cut; focus rides the head. 9:16: the
path steps diagonally top-left → bottom-right and the camera follows. Sound: amber bell tones on the
arrivals (D5+F5, A5, C6).

### 13 · the ramp test — 18.0–19.0 (`impact.js`)
three.js, one shot, match-cut from the Ramp traverse node: a 15° ramp wedge (hatched top ~12 %, edges
~17 %) on a dark floor grid, the rover (points + edges, dimmed, ghosted) parked at the foot of the ramp —
it does not drive. A raking light crosses the slope. Callouts projected from 3D anchors: angle arc
"15°", arrow up the slope "≥ 0.5 m/s". A label island anchored in 3D: flask glyph, "Ramp traverse with
payload", amber dot, "Out of date"; under it the test's recorded expectation in Plex Mono `#848890`: "Expected · Reaches ≥0.5 m/s mid-ramp, no slip". Slow push and 6° orbit. 9:16: ¾ front view so the slope climbs bottom-left →
top-right. Sound: low motor hum (no drive), ticks on callouts, small riser.

### 14 · agents propose. — 19.0–20.0 (`hero.js`)
Graphite. "agents propose." Geist 600 180 px, x 160, baseline just above the thread, `rise`, words
0.125 s apart from 19.0. Far behind: the agent's recorded call rows as texture (Plex Mono 22 px,
`#64676f` at ~25 %, pre-blurred) scrolling up in two columns (tool · object, no "ok"). Top-right: live
dot (signal, breathing) + "Agent". The thread is the underline. Push 1.0→1.03. 9:16: two lines, 200 px,
x 80, the thread under the second line. Sound: hit + clap at 19.0, rising four-note figure into 20.0.

### 15 · people decide. — 20.0–22.5 (`hero.js`)
Hard cut to Paper on the downbeat: "people decide." Geist 600 180 px ink, same position, present on the
cut frame. Nothing else: ink thread underline, faint 24 px dot grid (~12 %), grain. At 20.5 the
thread's right end gains an ink open chevron (the consequence end). Hold 0.5 s, then push 1.0→1.03.
9:16: two lines, 200 px. Sound: the apex — full chord over a pedal, low hit, cymbal swell, sustained.

### 16 · the machine, whole — 22.5–24.0 (`converge.js`)
Hard cut to graphite: the bookend. The Sable rover point cloud, assembled, ¾ hero view, a final raking
light pass (22.5–23.2), no copy. 23.2–23.75: every point collapses — first onto the thread's line
(points flatten to y = thread), then the hairline contracts toward one 6 px point of light with bloom
at the **mark's apex position in the lockup layout** (16:9 and 9:16 each). 23.75–24.0: black but the
point. Sound: accelerating ticks 16ths→32nds, whoosh, music cut at 23.75 with a reverse swell, final
hit at 24.0.

### 17 · lockup — 24.0–29.0 (`end.js`, built)
The mark cuts in under the point of light (never animated), wordmark rises letter by letter, "See the
whole." 24.5 · "Focus on one." 24.9 · "Decide." 25.3, CTA at 25.7 in Plex Mono: "Free and open source ·
macOS (Apple Silicon) · Linux preview" and "github.com/abdraiymbek/omen-flow". Full card holds 25.7–28.2, fade to
field 28.2–29.0. Sound: final hit rings out, three soft bells on the tagline, decayed by ~26.8, silent
tail.

## Score (scripts/launch-audio.mjs)
D minor, 120 BPM, synthesised with `scripts/synth.mjs` from the same times as the picture.
0.0 hit + air · 0–1.5 sub swell, air riding the light, glass ticks · 1.5 heavy hit, metal shards ·
3.0 hit, plucks per island, kick drops out · 4.5–6.0 kick returns, key ticks, tocks per call row, riser ·
6.0–7.0 micro-click rush rising with x, lock thump 7.0, riser · 7.5–8.0 BREATH (near silence, inhale) ·
8.0 TITLE HIT · 9.0–12.5 groove (kick, clap on 2 and 4, bass 8ths, pad ducked), shimmer at 10.0, ticks
per node, toms 11.0 and 11.75 · 12.5–14.0 thinned, scratch at 13.0, whoosh 13.4 · 14.0–15.94 tension,
roll of 16ths 15.5–15.94, a 32nd of silence (15.9375–16.0) · 16.0 PRESS (click + sub + minor→major stab) · 16.5–18.0
groove + amber bells on the arrivals (16.75 tray + mass, 17.25 ramp, 17.75 torque) · 18.0–19.0 hum, ticks, riser · 19.0 hit + clap, four-note
rise · 20.0 APEX · 22.5–23.75 accelerating ticks, whoosh, cut, reverse swell · 24.0 LOGO HIT, bells on
the tagline (24.5, 24.9, 25.3), decayed by ~26.8 · silent tail to 29.0.
