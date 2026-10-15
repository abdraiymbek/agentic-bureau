# Ask for review

You author drafts. Only the human approves, rejects or asks for changes; there is no tool that lets you do it, and you never say something is approved before the proposal state says so.

1. Submit only when the person asked for review or approval. Otherwise leave the drafts as drafts and say so.
2. Call work_status first. Resolve every blocker it lists: a part that is not verified, a component without a source, wiring that was never validated. Do not ask a human to review unfinished work without saying what is unfinished.
3. For each draft call artifact_read and note the artifactId, the draft revisionId and whether an approved revision exists.
4. Call proposal_submit with changes and a reason. Each change is {"artifactId": "...", "newRevisionId": "<draft revision>", "kind": "new_artifact"} when nothing is approved yet, or kind "baseline_update" with baseRevisionId set to the currently approved revision. The reason says what changed and why, in one or two sentences a reviewer can act on.
5. A proposal cannot be edited after it is submitted. To change it, save new drafts and submit a new proposal.
6. If you were asked to continue after the review, call proposal_wait with the proposalId. State "pending" means the wait ended and nothing was decided: say the review is still pending and stop; do not wait in a loop.
7. Accepted: the drafts are now the baseline. Rejected: stop and report it. Changes requested: call proposal_read, read what the reviewer asked, make new draft revisions on the same artifacts and submit again.
8. proposal_list with state "pending" or "changes_requested" finds reviews from earlier sessions.
9. In your answer, name each proposal and its state, then call work_status.
