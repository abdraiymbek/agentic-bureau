/**
 * The Omen Flow agent guide: how an agent CLI should work inside a project.
 * Written to `<project>/AGENTS.md` at session start (Codex and most agent CLIs
 * read that file from the working directory automatically) and included in
 * the per-session bootstrap brief.
 *
 * Deliberately short. The tools carry their own descriptions; this covers the
 * things a tool description cannot: the project model, the workflow that
 * earns "done", and the OpenSCAD conventions that trip up otherwise-correct
 * geometry.
 */

export const GUIDE_MARKER = '<!-- omenflow:agent-guide -->';

export function agentGuide(): string {
  return `${GUIDE_MARKER}
# Working in this Omen Flow project

Omen Flow is a local engineering workspace. Project state lives in \`.omenflow/state.sqlite\`
and is reached through the **omenflow MCP tools** (\`cad_write_source\`, \`cad_check\`,
\`artifact_list\`, …). Call them directly as tools — their schemas are self-describing. Only if
no MCP tools are available fall back to the shell: \`omenflow call <op> --help\` prints an op's
schema and \`omenflow call <op> --input file.json\` calls it. Files under \`artifacts/\` are
readable mirrors — do not edit them by hand or shell out to CAD tools; every change must go
through the tools so it is recorded as a revision.

## Project model
- Everything is an **artifact** (requirement, mechanical part, component, calculation, test…)
  with immutable **revisions**. Your work is always a *draft* revision; a human approves drafts
  into the baseline via proposals. Never claim something is approved.
- Every tool response includes the ids you need next (\`artifactId\`, \`revisionId\`). Use them;
  do not re-derive state from the filesystem.
- \`project_summary\` gives a bounded overview; \`artifact_list\` / \`artifact_read\` for details.

## Structured artifacts — visible content, not title-only records
- Before creating or updating a non-CAD artifact, call \`tool_describe\` with
  \`op: "artifact.create_draft"\` and \`artifactType\` to read its exact \`payloadSchema\`.
  Write content into those fields. Read back the returned revision and check the intended
  content survived. Continue on the same artifact id for updates.
- Populate all applicable fields from the request and recorded evidence. Preserve units and
  source references. Record unknown quantities as \`{unknown: true, reason: "..."}\`;
  explain missing facts rather than inventing numbers, URLs, prices, or test outcomes.
- Requirements: statement, target, acceptanceCriterion, priority, verification, sourceId.
  Assumptions: statement, value, reason, uncertainty, owner, needsValidation.
- Architecture and notes: markdown (architecture can also carry diagramSvg).
  Concepts: description, systems, approxDimensions, alternatives, uncertainties, visualFile.
  Subsystems: description. Software: files, language, entryPoint, notes; attach source files
  in the revision's files as well so they can be opened.
- Suggested purchased parts: use \`source_capture\` then \`component_add_candidate\` with maker,
  partNumber, description, sourced properties/attributes, sourceId, and an offer containing
  seller and the real product URL. Price may be null. Add other sellers with
  \`component_add_offer\`. Offers are separate records, not fields in a component payload.
  Do not leave suggested parts or links only in your terminal response.
- Electrical work uses artifact type \`wiring\` (not "electrical" or "electronics"). Populate
  pins and connections with exact component artifact/revision ids, pin names, signalRole,
  known voltage ranges, wire ratings, polarity, notes, and coverageNote. Create component
  drafts first to obtain ids. Call \`wiring_render\` and \`wiring_validate\` on the exact wiring
  revision; read findings and state coverage limits. A diagram is not electrical validation.
- Calculations: use \`calculation_run\` for executable results; otherwise record expression,
  inputs, assumptions, limitations, and the actual result/evidence kind. Never invent a run.
  Assembly: ordered steps with componentRefs, tools, calibration. Tests: procedure, expected
  outcomes, conditions; recorded results require actual observations and evidence.
- At completion, check each created artifact with \`artifact_read\` using its revisionId.
  Confirm content, linked sources/offers and files exist. Mention unresolved missing data.

## Parts (CAD) — the loop that earns "done"
1. **Write**: \`cad_write_source\` with the complete OpenSCAD source as plain text (\`title\` for a
   new part, \`artifactId\` to revise one). It saves a draft revision, renders it, and returns a
   measured report: envelope, volume, watertightness, bodies, mid-plane cross-sections
   (holes/outlines with positions and diameters), detected parameters, OpenSCAD warnings.
2. **Read the report** against the request. Wrong envelope, missing hole, two bodies, a
   warning — fix the source and write again.
3. **Trial the complete check**: your first \`cad_check\` for a new request must explicitly
   set \`exploratory: true\`. Derive expectations **from the request, never
   copied from the report** (a check that restates the measurement proves nothing): \`bbox\`,
   \`volume\` when you can compute it, \`sections\` with each hole's center and diameter and
   the outline size, \`solid\`/\`empty\` probe points for pockets, blind depths and chamfers,
   \`shells: 1\` for a single part. Cut sections through the middle of features, never on a face.
   This trial is not verification. Fix geometry that violates the request; fix a mistaken
   probe only by explaining why that expectation misread the request. Keep every requested
   dimension and feature covered. Do not remove valid failed requirements.
4. **Commit verification**: after the complete exploratory check passes, repeat its exact
   \`expect\` on the same revision with \`exploratory: false\`. Do not finish after the trial.
   An open edge pocket
   changes the outer contour; it is not a closed hole/slot or a rectangular outer loop.
   Never choose expectations merely to match measured output. Existing committed scopes
   remain binding even during exploration; a new request does not erase previous evidence.
5. **Finish only from the readiness result**. After a committed check fails, fix geometry
   and repeat the same assertions. If the committed assertion misread the request, stop and
   ask the reviewer to accept a corrected scope; explanation alone cannot accept it.
   Your final response must explicitly name any unresolved verification state and next action.
- \`ready: true\` is the declared-evidence completion gate. A geometric \`pass\` alone is not verified readiness.
  Read \`verificationStatus\` and \`work.nextAction\`: \`passed\`
  binds this exact revision and declared scope; \`scope_changed\` needs the committed assertions restored or human
  acceptance — do not claim the part is verified; \`partial\` needs explicit dimensions/features; \`unverified\` needs
  a matching committed render. Keep prior assertions when fixing geometry; do not erase failures.
- \`cad_inspect\` measures arbitrary planes/points (use it to debug). It does **not** bind request assertions.
  Axis-aligned: \`axis\`+\`at\`. Inclined holes: \`origin\`+\`normal\` plus \`probes\` through the bore.
  \`cad_check\` with \`exploratory: true\` is the same class of diagnostic: it must not replace the committed spec.
- \`cad_read_source\` returns an existing part's source. \`cad_set_param\` changes one file-scope
  \`name = value;\` (prefer this for a single dimension). \`cad_patch_source\` replaces one unique
  snippet. \`cad_write_source\` still accepts a full rewrite.
- \`cad_compose\` places existing parts with translate/rotate only — no mates, no STEP. Each
  source is wrapped in a module so file-scope names do not collide.
- Modify a part on the **same** \`artifactId\` — never create a second artifact for a change.
  \`cad_check\` \`preserve.changeRegions\` compares the original baseline/reference so unrelated geometry stays put; source-only references render automatically. Rewriting the candidate never resets that reference.

## OpenSCAD conventions that matter
- Units are millimetres. +Z is up. Coordinates in the request are absolute unless stated.
- V0.1 source must be self-contained and deterministic: no \`include\`, \`use\`, \`import\`,
  \`surface\`, host-font \`text()\`, or \`rands()\`. Inline construction source, use explicit dimensions,
  and explain this supported boundary instead of retrying unsupported dependencies.
- Set \`$fn\` (e.g. \`$fn = 64;\` at top) so round features are round. If you omit it on a cylinder
  / sphere / circle, the harness injects \`$fn = 64\` so a default pentagon cannot sneak through.
- Cutters in \`difference()\` must extend past the faces they cut (start below, end above);
  a cutter that ends exactly on a face leaves a zero-thickness skin.
- Parts that must be one body need overlapping volumes; touching faces are not joined.
- For \`polyhedron()\`, list face vertices **clockwise when viewed from outside**. An
  inside-out source is not verified even if the display mesh was normalized. Reverse the
  face winding, rewrite the source, and repeat the same checks; do not ignore that report.
- \`rotate([90,0,0])\` turns a Z-axis cylinder to point along **−Y**; \`rotate([-90,0,0])\` → +Y;
  \`rotate([0,90,0])\` → +X. Check the report's cross-section on the axis you drilled through.
- For a plane \`z = a*x + b*y + c\`, a normal is \`[-a,-b,1]\`; the opposite
  direction reverses **all three** components. Derive it from the requested plane, then
  check its dot products with both tangents \`[1,0,a]\` and \`[0,1,b]\` are zero.
  Compute bore test points from \`entry + t*normal\`, independently of the construction's
  rotation formula. A tilted circular bore appears elliptical in an axis-aligned section:
  more tessellation cannot make that ellipse circular. Use a normal-plane inspection and
  analytically projected section dimensions/roundness, rather than repeatedly changing \`$fn\`.
- Blind depths are measured from the face being drilled into, so compute the hole's end
  coordinate from that face, not from the origin.
- For \`cylinder(..., $fn = N)\` polygons, \`d\` is the across-corners diameter; across-flats is
  \`d · cos(180/N)\`.
- Expose key dimensions as top-level \`name = value;\` variables so the part is parametric.

## Efficiency
- Do not explore the filesystem or run git; the project state is in the tools.
- One \`cad_write_source\` + one \`cad_check\` is the ideal path. Do not export, propose, or
  request review unless asked.
`;
}
