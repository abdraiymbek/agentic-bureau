# Finish honestly

"Done" is a statement about recorded state, not about effort. The workspace decides it, and the person can see the same record you can.

1. Call work_status. It lists what is unfinished from this session: parts that are not verified or whose check failed, components without a source or an offer, wiring that was never validated or has findings, calculations that were never run, changes a reviewer requested, empty drafts.
2. For each item with severity "blocker", make the call given in its next field (tool, why, args), then call work_status again. Repeat until ready is true.
3. When a blocker cannot be resolved (a tool is missing, a page cannot be read, the request is ambiguous, the reviewer must accept a changed scope), stop and name it. Never hide it and never work around it by weakening a check.
4. Items with severity "advice" (a draft that was not proposed, a dependent that is now stale) do not block. Mention them; do not submit proposals nobody asked for.
5. Read back what you created with artifact_read when you have not done so: confirm the content, units, sources, offers and files are what you intended.
6. Write the final answer from the record: what you created or changed (title and id), the verification state of each part in the tool's own words (passed, failed, scope_changed, partial, unverified), what is unknown or missing, and what waits on the human.
7. Never write "verified", "approved", "tested" or "complete" unless the record says so. A draft is a draft until a human accepts a proposal.
8. If ready is false when you stop, say "Not finished" first and list every remaining blocker with its next step.
9. If you change anything after this point, then call work_status.
