# Rust migration: after measurements

Measured on 2026-09-22/23 (America/Chicago), macOS Apple Silicon, from the
unsigned packaged Tauri app. Baseline: [packaged Electron measurements](../baseline/README.md).
The same disposable 500-artifact project with a 99,852-triangle OpenSCAD sphere
was copied to `/tmp/omen-rust-migration-after-fixture/project`. The packaged
Rust app reopened the copy and displayed the actual sphere in the STL viewport.
The research window and a native custom PTY/bridge command were also exercised.

| Measurement                             |  Electron before |       Rust after |                                         Difference |
| --------------------------------------- | ---------------: | ---------------: | -------------------------------------------------: |
| Warm launch → bridge ready, p50         |         304.5 ms |         203.6 ms |                                         33% faster |
| Launch → bridge ready, p95              |       1,921.8 ms |         214.6 ms | Baseline includes one 1,921.8 ms first-run outlier |
| Overview idle, maximum summed RSS       |        491.6 MiB |        274.3 MiB |                              217.3 MiB / 44% lower |
| STL viewport idle, maximum summed RSS   |        525.4 MiB |        489.4 MiB |                                36.0 MiB / 7% lower |
| Overview idle, mean CPU, one core       |            0.02% |            0.57% |                 Rust sample higher; both near idle |
| STL viewport idle, mean CPU, one core   |            0.29% |            0.28% |                                            Similar |
| `artifact.read`, source-core p50 / p95  | 0.289 / 1.043 ms | 0.619 / 0.992 ms |                        Median slower, tail similar |
| `project.search`, source-core p50 / p95 | 0.495 / 0.866 ms | 0.179 / 0.510 ms |                                 Median 2.8× faster |
| `cad.inspect`, source-core p50 / p95    | 541.4 / 581.0 ms |   28.8 / 33.4 ms |                                Median 18.8× faster |

Methods: ten sequential packaged launches with fresh isolated app data and a
warm OS file cache; 60 one-second `ps` samples per idle screen; 30 sequential
source-core calls per command on the same fixture. Startup measures bridge
readiness, not first paint or complete workspace readiness. Command times
exclude UI transport, renderer work, OpenSCAD rendering, and agent provider
latency. Idle CPU is not interactive frame time. The high-triangle viewport
still uses WebGL in the OS webview, explaining why its total RSS is close to
Electron despite a much smaller Rust main process (145.1 MiB viewport maximum).

Electron RSS summed its process tree. WebKit's GPU, WebContent, and Networking
processes were reparented to PID 1 on this machine, so Rust RSS sums the app
with WebKit XPC PIDs newly created at launch. This is a launch-delta estimate;
shared mapped pages are counted in each process. These figures are directional,
not private-memory attribution. The 0.57% Overview CPU sample should not be
represented as an idle CPU improvement.

Raw samples and sampler scripts are adjacent to this file. `session.json` records
the disposable fixture and PIDs. No user project was measured or modified.
Measurements were taken before the final minor parity and documentation edits;
those edits do not change the renderer or dispatch paths used by these samples.
