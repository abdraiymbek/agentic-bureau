# Project format

An Omen Flow project is an ordinary folder:

```text
<Project>/
  omenflow.project.json        identity + format version
  README.md                 human-readable intro
  artifacts/                readable working views (generated, editable)
    requirements/ research/ concepts/ components/ mechanical/
    electronics/ calculations/ software/ assembly/ tests/
  exports/                  user-requested build packages
  .omenflow/
    state.sqlite            canonical entities/revisions/graph/history
    objects/                immutable content-addressed files (SHA-256)
    work/                   per-session draft/output dirs
    recovery/               interrupted-operation records
    cache/                  regenerable previews/search extracts
```

## Canonical state

SQLite (`state.sqlite`) is the only writable store of engineering truth.
Files under `artifacts/` are generated views at a recorded revision; external
edits are imported as drafts, never silently accepted.

`omenflow.project.json`:

```json
{ "format": "omenflow-project", "version": 1, "id": "<uuid>", "name": "..." }
```

## Objects

`.omenflow/objects/<xx>/<sha256>` — immutable blobs. Revisions reference blobs by
hash; generated views link (never hard-link writable files to objects).

## Portability

Project archives carry a consistent SQLite backup plus all referenced objects
and a portable JSON/Markdown snapshot. Absolute tool paths and credentials are
never stored in project records — they live in per-user app settings.
