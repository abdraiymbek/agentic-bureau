# Rust migration: after measurements

Measured on 2026-09-22/23 (America/Chicago), macOS Apple Silicon, from the
unsigned packaged Tauri app. Baseline: [packaged Electron measurements](../baseline/README.md).
The same disposable 500-artifact project with a 99,852-triangle OpenSCAD sphere
was copied to `/tmp/omen-rust-migration-after-fixture/project`. The packaged
Rust app reopened the copy and displayed the actual sphere in the STL viewport.
The research window and a native custom PTY/bridge command were also exercised.
In an earlier packaged UI run, OpenSCAD started from the render button, showed
its running state, and produced draft revision 3. The approved revision remained
selected; SQLite `integrity_check` returned `ok` with 500 artifacts. The final
measurements reused this fixture with the extra unapproved draft present.
The final packaged binary subsequently rendered draft revision 4; its job
succeeded, `integrity_check` returned `ok`, and approved revision 1 remained
selected.

| Measurement                             |  Electron before |       Rust after |                                         Difference |
| --------------------------------------- | ---------------: | ---------------: | -------------------------------------------------: |
| Warm launch → bridge ready, p50         |         304.5 ms |         203.1 ms |                                         33% faster |
| Launch → bridge ready, p95              |       1,921.8 ms |         203.7 ms | Baseline includes one 1,921.8 ms first-run outlier |
| Overview idle, maximum summed RSS       |        491.6 MiB |        274.6 MiB |                              217.0 MiB / 44% lower |
| STL viewport idle, maximum summed RSS   |        525.4 MiB |        491.0 MiB |                                34.4 MiB / 7% lower |
| Overview idle, mean CPU, one core       |            0.02% |            0.33% |           One 17.4% sample dominates the Rust mean |
| STL viewport idle, mean CPU, one core   |            0.29% |           <0.01% |         Both near idle; not interactive frame time |
| `artifact.read`, source-core p50 / p95  | 0.289 / 1.043 ms | 0.644 / 0.934 ms |                        Median slower, tail similar |
| `project.search`, source-core p50 / p95 | 0.495 / 0.866 ms | 0.310 / 0.639 ms |                                 Median 1.6× faster |
| `cad.inspect`, source-core p50 / p95    | 541.4 / 581.0 ms |   27.9 / 33.4 ms |                                Median 19.4× faster |

Methods: ten sequential packaged launches with fresh isolated app data and a
warm OS file cache; 60 one-second `ps` samples per idle screen; 30 sequential
source-core calls per command on the same fixture. Startup measures bridge
readiness, not first paint or complete workspace readiness. Command times
exclude UI transport, renderer work, OpenSCAD rendering, and agent provider
latency. Idle CPU is not interactive frame time. The high-triangle viewport
still uses WebGL in the OS webview, explaining why its total RSS is close to
Electron despite a much smaller Rust main process (148.8 MiB viewport maximum).

Electron RSS summed its process tree. WebKit's GPU, WebContent, and Networking
processes were reparented to PID 1 on this machine, so Rust RSS sums the app
with WebKit XPC PIDs newly created at launch. This is a launch-delta estimate;
shared mapped pages are counted in each process. These figures are directional,
not private-memory attribution. The Rust Overview mean CPU includes one 17.4%
sample at second 14; 57 of 60 samples were below 0.5%. Sub-0.01% viewport CPU
readings are below the precision at which `ps` supports an improvement claim.

Raw samples and sampler scripts are adjacent to this file. `session.json` records
the disposable fixture and PIDs. No user project was measured or modified.
These after samples were repeated on the final package after the background CAD
render, cancellation, direct SQLite worker, and single-instance changes. The
executable SHA-256 is recorded below for comparison with a subsequent build.

`SHA-256` of `Omen Flow.app/Contents/MacOS/omenflow-rust-desktop`:
`a9e0be01886083b32243b61245bbe47669e3108b5123d2c60d059cfe2c9d63d7`.
