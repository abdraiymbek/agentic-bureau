# Security

## Reporting

Report suspected vulnerabilities privately to the maintainers rather than in a public issue.
There is no published security contact yet; one must exist before the first public release.

## Model

Omen Flow is a local desktop application. It runs no service reachable from other machines.
What it protects is the engineering record: what becomes a baseline, and who decided it. It
does not contain the agent CLI you run.

### Agents

An agent CLI is a program you chose, running with your operating-system permissions. Omen Flow
does not sandbox it. It can read and write anything you can, including the project folder and
`.omenflow/state.sqlite` itself, and it makes its own network connections to its model
provider. Codex CLI is started with its own `workspace-write` sandbox (network allowed);
Claude Code with `--allowedTools mcp__omenflow`, which pre-approves only Omen Flow's tools and
leaves the CLI's other permissions as you configured them. Other CLIs run as configured.

Through Omen Flow's tools an agent can do only what the operation registry marks agent-allowed
(65 of the 106 operations): read the project, create and update drafts, write and check CAD,
run calculations, record candidates, offers and test results as drafts, propose selections and
BOM edits, submit proposals and wait for review, link objects and remove links an agent added,
and read public web pages through the app's research reader. It **cannot** approve, reject or
request changes on a proposal, accept a draft as baseline, edit, revert or archive a baseline,
change settings, start or drive terminals, import or export archives, or reveal files. The
agent host refuses these before they reach the core (`CAPABILITY_DENIED`), and the core refuses
them again for agent origin. The review gate governs what Omen Flow records; it cannot stop a
process from editing the database file directly. Changes made that way bypass review and are
not attributed.

Web pages an agent reads are returned marked as untrusted content. A model can still follow
instructions it finds there; review what it proposes.

### The bridge

Agents reach the app through the bundled `omenflow` helper and a local socket at
`<app-data>/run/bridge.sock` (directory `0700`, socket `0600`; on Windows a named pipe
`\\.\pipe\omenflow-<user>-bridge` with default pipe security, not verified on Windows). The
first frame must carry a session token: 24 random bytes, issued when a session starts, held only
in memory, bound to one project, one session and one capability profile, and revoked when the
session ends. The token reaches the CLI as `OMENFLOW_BRIDGE_TOKEN`; for Claude Code it is also
in the session's `mcp.json` (`0600`, removed when the session ends). Any process running as you
that can read that environment or file can use the token while the session runs. Inherited
`OMENFLOW_*` variables are removed from the CLI's environment, and configured variables cannot
replace the session's credentials.

### The renderer

The interface runs in the system webview with one Tauri capability (`main`: core defaults,
window dragging, dialogs, opener) and two app commands: `omenflow_command`, which carries any
user-origin operation and validates it against the contracts, and `toggle_research`. The
command surface includes configuring and starting an agent executable, so whatever runs in the
renderer is trusted. It is kept to the app's own code by a content security policy
(`script-src 'self'` plus one hashed inline script; images may come from `https:` for product
photos) and a navigation guard that refuses any other origin and sends `http`, `https` and
`mailto` links to the system browser. Markdown and SVG from the record are sanitised before
display.

### Research

The research window is a separate, incognito webview with no preload, no Node and no
application IPC; only the app's own extraction scripts run in it. It loads public `http` and
`https` pages only: URLs with credentials, and hosts that are or resolve to loopback, private,
link-local or other reserved addresses, are refused, and each navigation is checked again.
Agent loads keep the window hidden; what is read from a page is bounded. A screenshot of the
page is taken by WebKitGTK itself on Linux (no screen-capture library is linked there) and of
the window by the system on macOS and Windows. The headless host has no research surface.

### The headless host

`omenflow-host` (development, conformance tests, the design preview, evaluations; not part of
the app bundle) listens on `127.0.0.1` only. Every request needs `Authorization: Bearer
<token>` (256 random bits unless one is given; compared in constant time), a `Host` header of
`127.0.0.1:<port>` or `localhost:<port>`, and no `Origin` header and no `Sec-Fetch-Site` other
than `none`, so a web page cannot reach it even through DNS rebinding. The token is accepted in
the query string only for the event stream. There are no CORS headers, and bodies and headers
are size-capped. The design preview keeps the token in its own process and forwards only
same-origin requests from its page.

### Files and data

- Project mutations stay inside the project folder: paths are canonicalised and refused when
  they leave it, including through symlinks, and working files can never be written into
  `.omenflow/`. Archive import and export check member names, case-insensitive duplicates,
  sizes, counts and object hashes, and refuse symbolic links.
- Settings — agent executables, arguments, **environment variables you configure for an agent**,
  models, the OpenSCAD path — are plain JSON in the per-user application data folder. They are
  not encrypted or kept in the system keychain. Do not put secrets there that you would not
  keep in a shell profile.
- Archives exclude settings, credentials, the cache, the agent session folders and terminal
  history, and remove machine paths from the copy of the database they carry. Revision
  payloads are not rewritten, so a render identity's OpenSCAD path remains; the export says so.
- The packaged smoke's requests (`OMENFLOW_SMOKE_PROJECT`, `OMENFLOW_SMOKE_AGENT`,
  `OMENFLOW_SMOKE_SNAPSHOT`) are honoured only together with `OMENFLOW_APP_DATA_DIR`, an
  isolated data folder, never on a normal launch. They create a project, write an agent grant
  to `<data>/run/smoke-grant.json` (`0600`), start the named executable as a Custom CLI agent
  session, and write a picture of the window. Whoever can set the app's environment can already
  run programs as you.
- SIGTERM, SIGINT and SIGHUP quit the desktop app through its normal exit path, which stops
  agent sessions (their whole process groups) and OpenSCAD renders; a second signal ends the
  process at once. SIGKILL or a crash skips that path.

## Not verified

The V1 work did not launch the native app on macOS: the navigation guard, the content security
policy with Tauri's IPC, and the hidden research window were verified by unit tests and
compilation, not at runtime. The Windows named pipe's access control and signed and notarized
macOS packages have not been checked.

Linux: the `.deb`, `.rpm` and AppImage were built for arm64 and run only in containers under a
virtual X display (Xvfb) — the `.deb` on Ubuntu 22.04, Ubuntu 24.04 and Debian 12, the AppImage
on Ubuntu 22.04, the `.rpm` on Fedora 42 — where the packaged smoke checked the bridge's token
refusal and grant round trip, the agent session's process group and a clean SIGTERM quit
([release](docs/release.md#linux-packages)). x86_64 packages come only from a CI job that has
not run. No Linux desktop session (a real X server or Wayland, a GPU, a person) has been used,
the research window was not exercised on Linux, and nothing is signed: no GPG signature on the
`.deb` or `.rpm`, no signed AppImage, no update information.
