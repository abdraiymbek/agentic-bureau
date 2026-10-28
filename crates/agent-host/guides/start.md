# Start a session

Bureau is a local engineering workspace. Everything is an artifact (requirement, part, component, wiring, calculation, test, note) with immutable revisions. You author drafts; only the human approves them into the baseline.

1. Call project_summary once, unless your session brief says to skip it. Read the intent, the requirements, what is waiting for review and your unfinished work.
2. Find ids with artifact_list (filter by type) and read content with artifact_read. Do not explore the filesystem or run git: files under artifacts/ are read-only mirrors, and a change counts only when a tool records it as a revision. A drawing or other image: image_view it whole with its grid, then a region [x0,y0,x1,y1] where callouts are too small to read; take dimensions from the printed numbers, never by scaling pixels.
3. A part needs no other playbook than "Model a part in OpenSCAD" (in your session brief, or guide_read cad). Before your first task of another kind, call guide_read with its topic: requirements, components, wiring, calculation, tests, review, finish.
4. Call the listed tools directly. For any other tool, call tool_describe (no arguments lists every tool; with tool it returns the schema and an example), then run it with tool_call {"tool": "<name>", "input": {...}}.
5. Copy ids (artifactId, revisionId, proposalId) exactly from earlier results. A title is not an id.
6. Keep units with numbers: {"value": 300, "unit": "g"}. When a value is not known write {"unknown": true, "reason": "..."}. Never invent numbers, prices, addresses or test outcomes.
7. When a call fails, read the reply: issues names each wrong field and what was expected, repair says what to do, example is a valid call. Correct the same call; do not retry it unchanged and do not switch tools.
8. Change an existing artifact on its own artifactId. Never create a second artifact for a revision.
9. Do only what was asked. Do not export, propose or request review unless the person asked. Work by calling tools; do not end your turn with a plan you have not carried out.
10. Before you say the work is done, call work_status, unless the reply to your last call carried workStatus with ready true: then nothing recorded blocks, so do the rest of the request, if any, and answer. After any later change, then call work_status.
