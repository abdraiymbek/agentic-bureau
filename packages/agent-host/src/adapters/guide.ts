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

## Parts (CAD) — the loop that earns "done"
1. **Write**: \`cad_write_source\` with the complete OpenSCAD source as plain text (\`title\` for a
   new part, \`artifactId\` to revise one). It saves a draft revision, renders it, and returns a
   measured report: envelope, volume, watertightness, bodies, mid-plane cross-sections
   (holes/outlines with positions and diameters), detected parameters, OpenSCAD warnings.
2. **Read the report** against the request. Wrong envelope, missing hole, two bodies, a
   warning — fix the source and write again.
3. **Verify**: \`cad_check\` with explicit expectations **derived from the request, never
   copied from the report** (a check that restates the measurement proves nothing): \`bbox\`,
   \`volume\` when you can compute it, \`sections\` with each hole's center and diameter and
   the outline size, \`solid\`/\`empty\` probe points for pockets, blind depths and chamfers,
   \`shells: 1\` for a single part. Cut sections through the middle of features, never on a face.
4. **Repeat** until every check passes. A failing check means the geometry is wrong until
   proven otherwise — fix the source; drop or loosen an assertion only when it misread the
   request, and say so. Execution without errors is not correctness; a report of "done" must
   cite passing checks.
- \`cad_inspect\` measures arbitrary planes/points (use it to debug). Axis-aligned: \`axis\`+\`at\`.
  Inclined holes: \`origin\`+\`normal\` (true normal-to-face cut) plus \`probes\` through the bore.
- \`cad_read_source\` returns an existing part's source. \`cad_set_param\` changes one file-scope
  \`name = value;\` (prefer this for a single dimension). \`cad_patch_source\` replaces one unique
  snippet. \`cad_write_source\` still accepts a full rewrite.
- \`cad_compose\` places existing parts with translate/rotate only — no mates, no STEP. Each
  source is wrapped in a module so file-scope names do not collide.
- Modify a part on the **same** \`artifactId\` — never create a second artifact for a change.
  \`cad_check\` \`preserve.changeRegions\` samples the parent revision so unrelated geometry stays put.

## OpenSCAD conventions that matter
- Units are millimetres. +Z is up. Coordinates in the request are absolute unless stated.
- Set \`$fn\` (e.g. \`$fn = 64;\` at top) so round features are round. If you omit it on a cylinder
  / sphere / circle, the harness injects \`$fn = 64\` so a default pentagon cannot sneak through.
- Cutters in \`difference()\` must extend past the faces they cut (start below, end above);
  a cutter that ends exactly on a face leaves a zero-thickness skin.
- Parts that must be one body need overlapping volumes; touching faces are not joined.
- \`rotate([90,0,0])\` turns a Z-axis cylinder to point along **−Y**; \`rotate([-90,0,0])\` → +Y;
  \`rotate([0,90,0])\` → +X. Check the report's cross-section on the axis you drilled through.
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
