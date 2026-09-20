# Security policy

## Reporting

Please report suspected vulnerabilities privately to the maintainers rather than
opening a public issue. Contact: security@omenflow.local (placeholder — replace with
the project security contact before first public release).

## Security model summary

Omen Flow is a local-first desktop application. Its responsibilities are bounded:

- The renderer is sandboxed with context isolation and no Node integration.
- IPC payloads are schema-validated; there is no generic shell or filesystem IPC.
- The agent bridge uses per-session random credentials on a per-user local
  socket; it is not a remote API.
- Project mutations cannot escape the selected project directory (canonical
  path + symlink validation).
- Connection credentials and Omen Flow secrets use OS-protected storage and are
  never exported.

Omen Flow does **not** attempt to sandbox a user-installed agent process — the agent
runs with the user's own OS permissions, exactly as it would outside Omen Flow.
Omen Flow's review gate controls acceptance into the managed engineering baseline;
it is not an OS-level sandbox.
