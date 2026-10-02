# First-use readiness audit — 26 September 2026

Status: **unsigned macOS Apple Silicon release candidate, validated locally**.
This pass hardens the current Rust/Tauri + Lens working tree. It preserves the
existing design, schema 1, operation names, and the user's in-progress changes.
The package version remains 0.1.0; this audit does not declare or publish a 1.0
release. Apple signing/notarization and clean-machine installation are still
required before public distribution.

## Reliability fixes

- Closing a project now waits for the native close, terminates its PTY, cancels
  its queued/running jobs, and releases its database. Repeated close clicks
  coalesce; a failed close keeps the project visible. Switching projects closes
  the previous one. Export commands retain the project that opened the dialog.
- Terminal restart resets the session output cursor and rejects old snapshots
  and late frames. Old child exit notifications cannot replace the new session.
  Native start/stop operations serialize; invalid adapter selection is checked
  before stopping a working session. Writing without a live PTY reports failure.
- The agent surface offers a visible retry after startup failure, reports startup
  progress, and focuses the terminal when it becomes live. An ended session still
  requires an explicit restart.
- Newer-schema projects retain their read-only flag through first and repeated
  opens. Agent startup is blocked in both renderer and native host before writing
  bootstrap files. Reopened writable projects mark leftover live session records
  interrupted; an already-open project's running sessions are preserved.
- CLI detection no longer holds the core lock while running external version
  commands. Version probes are capped at two seconds and 4 KiB of output.
- Archive identity conflicts are detected before extraction. Only that explicit
  conflict triggers import-as-copy; malformed archives are not blindly retried.
- The saved OpenSCAD path is loaded in Settings and used by Rust diagnostics,
  synchronous CAD operations, and background renders. An empty saved path restores
  automatic detection. The selected path is scoped to a dispatch/worker, without
  changing the process environment or another app instance's engine selection.
- Tauri's exit callback explicitly shuts down owned PTYs, rather than relying on
  managed-state destructors running before process exit.

## Automated verification

| Check                                           | Result                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| Workspace TypeScript typecheck                  | Passed                                                               |
| JavaScript suite with `OMENFLOW_OPENSCAD_E2E=1` | 42 files, 354 tests passed, no skips                                 |
| Rust workspace tests                            | 38 passed                                                            |
| Rust clippy, all targets, warnings denied       | Passed                                                               |
| Rust formatting                                 | Passed                                                               |
| ESLint on changed renderer/tests                | No errors or warnings                                                |
| Full repository ESLint                          | No errors; 54 existing warnings                                      |
| Repository Prettier and `git diff --check`      | Passed                                                               |
| `pnpm dev`                                      | Compiled and launched current native development binary              |
| `pnpm make`                                     | Built app and unsigned arm64 DMG                                     |
| `pnpm smoke:packaged`                           | Final bundle launched; helper, framing, authentication denial passed |

The initial full real-engine run hit a legacy TypeScript PTY test race. The test
sent its next command immediately after Ctrl-C, allowing the terminal driver to
flush that input. It now waits for the shell's explicit interrupt acknowledgement
before continuing. The final full run passed. No timeout was increased.

Rust's optional compatibility-fixture test returns early without
`OMENFLOW_COMPAT_FIXTURE`; its presence in the count does not establish a new
500-artifact upgrade qualification. The native archive round trip below separately
checks real saved data. Existing large-bundle and Vite CJS advisories remain.

## Native acceptance

Performed with the actual packaged app, disposable app data, and a disposable
project. The custom adapter ran `/bin/sh -i` as a deterministic test process.
This exercises the real PTY and shipped `omenflow` helper; it is **not a new live
model/provider evaluation**. OpenSCAD identified itself as 2026.09.18.

1. Created a project from the launcher through the native folder picker.
2. Selected the custom adapter; Settings' bridge test reported working.
3. Started the Agent tab and ran the packaged helper from its real terminal.
4. Created a requirement draft and proposal through the authenticated agent
   connection. Reviewed and approved it in the native Decisions view.
5. Rendered a 20 mm cube with real OpenSCAD. The object stage displayed the STL,
   units, 20 × 20 × 20 mm bounds, draft state and revision. Accepted its baseline
   through the explicit user control.
6. Ended and restarted the shell. Verified fresh output was visible immediately
   instead of being suppressed by the previous session's sequence cursor.
7. Exported a project archive through the save dialog; success reported nine files.
8. Closed the project with the shell active. Verified its PID disappeared and its
   persisted session state became `exited`.
9. Imported the archive through the native picker into an empty folder. Both
   selected revision IDs were preserved, SQLite integrity checks returned `ok`,
   and every imported object matched its SHA-256 filename.
10. Started a shell in the imported project, quit the app, and verified that PID
    disappeared.
11. Launched the final rebuild. Verified a deliberately invalid configured engine
    (`/usr/bin/false`) appeared in Settings and diagnostics as unavailable; cleared
    the setting successfully.
12. Opened a disposable copy with marker version 999. The titlebar reported
    Read-only, intent editing was disabled, and Agent displayed the read-only
    explanation with no session startup.

The disposable project, helper exercise script, and native results remain under
`/private/var/folders/nk/5wlz1lmd63z6h9x2yh8pcgxm0000gn/T/omen-v1-audit-u8wfx5ka`.
No user's engineering project was changed. The installed `scu` command failed
with a missing module; native walkthrough used the available CUA connector.

The populated design preview covered Parts candidates/BOM, missing-data labels,
Timeline, Files and source preview, plus the missing-agent recovery state in
Graphite and Paper at 1024 × 700. The native package used its 1440 × 900 window.
This is targeted visual acceptance, not a new exhaustive accessibility audit.

## Distribution boundary

The output is `target/release/bundle/dmg/Omen Flow_0.1.0_aarch64.dmg` and
`target/release/bundle/macos/Omen Flow.app`. Use [the signing handoff](../../docs/release.md)
with Apple credentials, then install and exercise the signed DMG on a clean
supported Mac. No signing credentials were used and nothing was published.

Windows/Linux acceptance, VoiceOver, a fresh model-provider campaign, and a
clean-machine populated-project upgrade are not qualified by this pass. Prior
engineering and scale limits remain in force; this audit makes no safety,
manufacturability, or universal crash-resilience certification.
