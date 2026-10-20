# macOS 1.0.1 packaging refresh

Date: 19 October 2026 (America/Chicago). Status: **published**.

The existing app was already fully ad hoc signed and passed strict signature checks. No
signature corruption or damaged seal was found. Without a Developer ID certificate and
Apple Developer Program credentials, Apple notarization cannot be performed. No new certificate,
fake publisher identity, global Gatekeeper changes or quarantine-removal installation step
was introduced.

The refreshed DMG retains the exact app from release commit
`d091f0a040496e016c7ec2998f9c3e2606909980` / `v1.0.1`, with app CDHash
`fc95bfb26b88ecce9a30652d50fc38a3a374d54c`. The application code and signatures were not changed.
It adds `INSTALL.txt` outside the sealed app with Applications and Open Anyway instructions.
All six Linux assets retain their original hashes. The tag remains at the original app source.

The new `pnpm release:macos:adhoc` packager checks identity, both version fields and the app/helper
signatures before staging. It compares every regular file, executable permission and symlink,
creates and verifies the DMG, mounts it read-only at a canonical path, repeats the checks,
validates INSTALL.txt and the Applications link, and runs the real packaged smoke. It replaces
the output only after these checks pass. The macOS CI package job now runs this gate too.

## Verification

- Source and read-only mounted app: `codesign --verify --deep --strict` passed. The helper also
  passed strict verification independently. Both signatures are ad hoc; no Developer ID or
  notarization is claimed.
- Positive packaging and mounted-helper round trip passed: project read, agent-attributed draft,
  human-only operation refusal and SIGTERM cleanup. Full source/staged/mounted app trees matched.
- Negative test: an intentionally modified sealed LICENSE was refused before packaging; the
  existing DMG was unchanged. No damaged candidate was published.
- A fresh copy with only its bundled helper quarantined passed the helper's clean-byte-copy path
  and bridge smoke. The original app bundle remained untouched.
- A fully Safari-quarantined disposable copy retained a valid signature. `syspolicy_check
distribution --json` exited 70 with exactly **Adhoc Signed App** (warning) and **Notary Ticket
  Missing** (fatal), without invalid-signature or damaged-seal findings. This is a policy refusal,
  not accepted notarization.
- Direct automated launch of the fully quarantined app did not produce a bridge grant before
  timeout. It is not recorded as a pass: the first-launch Gatekeeper approval was not automated.
  An attempted native UI observation was inconclusive. No Open Anyway exception was added.
- Script syntax, focused ESLint, formatting and the two checksum merge regressions passed.
- The published refreshed DMG and SHA256SUMS were downloaded again and matched their GitHub
  SHA-256 digests. All seven manifest entries matched the release digests. A stale cached
  SHA256SUMS response immediately after asset replacement was resolved with a digest-keyed
  download URL; no incorrect manifest was published.

The original DMG SHA-256 was
`a8a59c1ddf6a6bbee780f2a2cf23657d042b3def6979e747e0a87100d3fb6734`.
The refreshed DMG SHA-256 is
`b80b397bd77233fcfab54c05e6cf4f3b52d6f895673328d7c54689c3f539b9e1`.
The current sizes, URLs and hashes are in [assets.json](assets.json) and [SHA256SUMS](SHA256SUMS).
Release author remains **abdraiymbek**.

## User flow and limits

Drag the app to Applications, eject the DMG and launch from Applications. If blocked, dismiss
the message and choose System Settings → Privacy & Security → Open Anyway → Open, authenticating
if asked. [Apple's instructions](https://support.apple.com/en-us/102445) describe this per-app
exception. Removing quarantine is not equivalent to that approval.

[Tauri documents ad hoc signing](https://v2.tauri.app/distribute/sign/macos/) for this accountless
case, with Privacy & Security approval still required. A valid seal addresses integrity failures,
but does not provide Apple's trust or guarantee exact dialog wording on every macOS version.
A fresh-machine browser download and manual Open Anyway walkthrough remain unverified; cached
assessment state on this Mac cannot establish those results.
