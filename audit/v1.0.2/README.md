# Omen Flow 1.0.2 verification record

Date: 20 October 2026 (America/Chicago). Status: **release candidate**.

This record covers release 1.0.2. Earlier test counts and packages do not qualify this build;
1.0.1 evidence remains in the [1.0.1 record](../v1.0.1/README.md).

## Changes

| Change                                | Intended everyday behavior                                                                                                                                                                                                                                                     | Verification                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| 1. Conversation pane                  | The Agent tab, floating window and dock show a conversation beside the terminal. Codex CLI or Claude Code runs headless once per message; its text appears as it arrives; it can present a part, a record, quantities, an illustrative chart, choices and human review inline. | automated regression and preview review passed |
| 2. Prepare → Send                     | Editing a card's values attaches the exact literal values, units, artifact and revision to a readable request. Only Send runs the agent; a stale revision is refused.                                                                                                          | automated regression and real render passed    |
| 3. One agent per project              | A conversation send is refused while an agent terminal runs, and a terminal start while a response runs (`BUSY`); each pane offers to stop the other.                                                                                                                          | host, conformance and preview checks passed    |
| 4. Ask follows the pane               | Every “Ask agent” entry point drafts into the conversation's composer or pastes into the terminal, by the active pane; nothing is sent for the person.                                                                                                                         | automated regression passed                    |
| 5. Conversation updates from the host | The host announces each change to a project's conversation record (`chat` event); the pane reads the record on it instead of polling.                                                                                                                                          | automated regression and preview review passed |

## Compatibility and limits

- Application, workspace package and helper versions are 1.0.2. The bundle identifier remains
  `app.omenflow.desktop`.
- Project storage remains schema 1. Conversations are kept additively in
  `.omenflow/chat/conversations.json`; project archives do not include them. The five `chat.*`
  operations are additive; existing `@omenflow` APIs, `omenflow call` and `omenflow mcp` remain
  supported.
- Terminal agents keep their behaviour, including `ui.open_artifact` and `ui.request_review`
  moving the workspace. Only a conversation run's requests become cards.
- Charts an agent presents are illustrative, never evidence. Agents cannot approve, accept or
  revert a person's baseline.
- The macOS app is ad hoc signed and is not notarized. OpenSCAD and agent CLIs are installed
  separately.
- Automated, preview and packaged smoke results do not establish a native manual walkthrough,
  a clean-machine installation, an upgrade, or use on a real Linux desktop.

## Final verification

Local candidate checks from [the release procedure](../../docs/release.md#local-candidate), on the
release commit's tree on macOS arm64 with OpenSCAD:

| Check                                                  | Result                                                                                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release version consistency and dependency-lock review | passed; workspace/app/helper 1.0.2; lockfiles change only local crate versions; new renderer dependencies streamdown 2.7.1, recharts 3.10.1 and react-is 18.3.1 with notices |
| Generated contracts and third-party notices            | passed                                                                                                                                                                       |
| TypeScript typecheck, lint and formatting              | passed; lint 0 errors, 124 warnings (unchanged)                                                                                                                              |
| JavaScript and renderer suites, including engine cases | 1046 passed across 105 files with real OpenSCAD; no skipped tests                                                                                                            |
| Rust formatting and clippy                             | passed with warnings denied                                                                                                                                                  |
| Rust workspace suites with OpenSCAD                    | 599 passed, 1 ignored; the ignored real-helper case passed separately                                                                                                        |
| Helper tests                                           | 13 passed                                                                                                                                                                    |
| Rust host conformance suites                           | 63 passed across 8 files, including the one-agent gate, `chat` events, and an exact-input render through the CLI bridge                                                      |
| Headless helper smoke                                  | passed read, agent draft and capability refusal                                                                                                                              |
| Renderer design-preview review                         | passed Graphite and Paper at 1440×900 and 1024×700 ([conversation pane](../../design-system/verification.md))                                                                |
| Real agent run in the preview                          | one Claude Code run read a part and presented its card; it changed nothing                                                                                                   |
