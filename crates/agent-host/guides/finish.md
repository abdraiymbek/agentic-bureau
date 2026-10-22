# Finish honestly

"Done" is a statement about recorded state, not about effort. The workspace decides it, and the person can see the same record you can.

1. Call work_status, unless the reply to your last call carried workStatus with ready true: that is the same answer, and nothing recorded blocks, so do the rest of the request, if any, before you answer. work_status lists what is unfinished from this session: parts that are not verified or whose check failed, components without a source or an offer, wiring that was never validated or has findings, calculations that were never run, changes a reviewer requested, empty drafts.
2. For each item with severity "blocker", make the call given in its next field (tool, why, args), then call work_status again. Repeat until ready is true.
3. When a blocker cannot be resolved (a tool is missing, a page cannot be read, the request is ambiguous, the reviewer must accept a changed scope), stop and name it. Never hide it and never work around it by weakening a check.
4. Items with severity "advice" (a draft that was not proposed, a dependent that is now stale) do not block. Mention them; do not submit proposals nobody asked for.
5. A requirement, component, wiring, calculation or test you wrote and no reply has shown back: read it once with artifact_read and confirm the content, units, sources and offers. A part's write reply already reports what was saved.
6. Write the final answer from the record: what you created or changed (title and id), the verification state of each part in the tool's own words (passed, failed, scope_changed, partial, unverified), what is unknown or missing, and what waits on the human.
7. Never write "verified", "approved", "tested" or "complete" unless the record says so. A draft is a draft until a human accepts a proposal.
8. If ready is false when you stop, say "Not finished" first and list every remaining blocker with its next step.
9. If you change anything after this point, then call work_status.
