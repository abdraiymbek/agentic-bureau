# Rust migration: pre-move baseline

Measured on 2026-09-22 (America/Chicago), macOS Apple Silicon, at Git commit
`84ebdc56372b49b61fabefaa1f2f3e4f4efe5a99`. `pnpm package` completed before
sampling. The packaged `app.asar` SHA-256 was
`9373fc384c8e2f1da6e37a8a4d6a434201a0053473686ac4c25e3b20783a2481`.
The executable SHA-256 was
`588478afc5f2bc73b6433d6e565a214dc830144be39a3d79805723292754ccd8`.

Disposable fixture: `audit/release-v0.1/measure-heavy.ts` created 500 artifacts
and a 99,852-triangle OpenSCAD sphere at
`/tmp/omen-rust-migration-baseline-fixture/project`. The command timing script
subsequently created a second draft revision of that sphere. The packaged app
opened that project through its native folder picker; the Overview showed 500
approved objects, and the Design files viewport visibly loaded the sphere.

| Measurement | Pre-move result | Method and limit |
| --- | ---: | --- |
| Bridge readiness, warm p50 | 304.5 ms | Ten isolated packaged launches; sample 1 was 1,921.8 ms and is retained in the p95, not discarded. This is bridge readiness, not first paint. |
| Bridge readiness, all-sample p95 | 1,921.8 ms | `audit/release-v0.1/measure-startup.mjs`; every launch passed packaged smoke. |
| Overview idle, maximum summed RSS | 491.6 MiB | 60 one-second `ps` samples of the packaged desktop process tree; includes shared pages. |
| Overview idle, mean CPU | 0.02% of one core | Same 60 samples; external providers excluded. |
| STL viewport idle, maximum summed RSS | 525.4 MiB | Same method with the 99,852-triangle mesh visibly loaded. |
| STL viewport idle, mean CPU | 0.29% of one core | Same 60 samples. This does not measure interactive frame time. |
| `artifact.read` p50 / p95 | 0.289 / 1.043 ms | 30 sequential source-core calls on the fixture; excludes UI transport. |
| `project.search` p50 / p95 | 0.495 / 0.866 ms | Same method. |
| `cad.inspect` p50 / p95 | 541.4 / 581.0 ms | Same method on the 99,852-triangle mesh. |

Raw samples are in the adjacent JSON files. The native idle sampler is
`audit/execution/measure-idle.py`, and the command sampler is
`audit/release-v0.1/measure-commands.ts`. The final Rust app must be measured
with the same fixture, sample count, process-tree accounting, and command set.
Changes in webview or OS process sharing must be disclosed alongside the numbers.

`scu session start` could not run (`ModuleNotFoundError: No module named 'scu'`),
so the native folder selection and viewport verification used the available
desktop computer-use tool. No user project data was opened or changed.
