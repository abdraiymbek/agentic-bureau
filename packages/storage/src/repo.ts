import type Database from 'better-sqlite3';
import {
  Artifact,
  BomLine,
  Decision,
  Edge,
  Job,
  Offer,
  Project,
  ProjectEvent,
  Proposal,
  Revision,
  SessionInfo,
  StaleRecord,
  newId,
} from '@stark/contracts';

type Row = Record<string, unknown>;
const J = (v: unknown) => JSON.stringify(v ?? null);
const P = <T>(s: unknown, fallback: T): T => (s == null ? fallback : (JSON.parse(String(s)) as T));

function toArtifact(r: Row): Artifact {
  return {
    id: r.id as string,
    type: r.type as Artifact['type'],
    title: r.title as string,
    subsystem: (r.subsystem as string) ?? null,
    selectedRevisionId: (r.selected_revision_id as string) ?? null,
    archived: !!r.archived,
    createdAt: r.created_at as string,
  };
}
function toRevision(r: Row): Revision {
  return {
    id: r.id as string,
    artifactId: r.artifact_id as string,
    parentId: (r.parent_id as string) ?? null,
    seq: r.seq as number,
    origin: r.origin as Revision['origin'],
    originDetail: (r.origin_detail as string) ?? null,
    createdAt: r.created_at as string,
    payload: P(r.payload, null),
    contentHash: r.content_hash as string,
    files: P(r.files, []),
    inputs: P(r.inputs, []),
    rationale: (r.rationale as string) ?? '',
    reviewState: r.review_state as Revision['reviewState'],
  };
}
function toEdge(r: Row): Edge {
  return {
    id: r.id as string,
    upstreamArtifactId: r.upstream_artifact_id as string,
    downstreamArtifactId: r.downstream_artifact_id as string,
    relationship: r.relationship as Edge['relationship'],
    requiredUpstreamRevisionId: (r.required_upstream_revision_id as string) ?? null,
    label: (r.label as string) ?? '',
    createdBy: r.created_by as Edge['createdBy'],
    createdAt: r.created_at as string,
  };
}
function toProposal(r: Row): Proposal {
  return {
    id: r.id as string,
    changes: P(r.changes, []),
    reason: r.reason as string,
    impact: P(r.impact, undefined),
    state: r.state as Proposal['state'],
    createdBy: r.created_by as Proposal['createdBy'],
    createdBySession: (r.created_by_session as string) ?? null,
    createdAt: r.created_at as string,
    resolvedAt: (r.resolved_at as string) ?? null,
    resolutionRationale: (r.resolution_rationale as string) ?? null,
  };
}
function toDecision(r: Row): Decision {
  return {
    id: r.id as string,
    proposalId: (r.proposal_id as string) ?? null,
    action: r.action as Decision['action'],
    actor: r.actor as string,
    ts: r.ts as string,
    rationale: (r.rationale as string) ?? '',
    priorBaseline: P(r.prior_baseline, []),
    newBaseline: P(r.new_baseline, []),
    eventSeq: r.event_seq as number,
  };
}
function toBomLine(r: Row): BomLine {
  return {
    id: r.id as string,
    componentArtifactId: r.component_artifact_id as string,
    componentRevisionId: r.component_revision_id as string,
    subsystem: (r.subsystem as string) ?? null,
    quantity: r.quantity as number,
    offerId: (r.offer_id as string) ?? null,
    location: (r.location as string) ?? null,
    notes: (r.notes as string) ?? '',
  };
}
function toOffer(r: Row): Offer {
  return {
    id: r.id as string,
    seller: r.seller as string,
    url: (r.url as string) ?? undefined,
    price:
      r.price_amount != null && r.price_currency != null
        ? { amount: String(r.price_amount), currency: String(r.price_currency) }
        : null,
    quantityBasis: (r.quantity_basis as number) ?? 1,
    availabilityText: (r.availability_text as string) ?? undefined,
    observedAt: r.observed_at as string,
    sourceId: (r.source_id as string) ?? undefined,
  };
}
function toJob(r: Row): Job {
  return {
    id: r.id as string,
    kind: r.kind as string,
    tool: r.tool as string,
    toolVersion: (r.tool_version as string) ?? null,
    inputs: P(r.inputs, null),
    inputHashes: P(r.input_hashes, {}),
    command: (r.command as string) ?? null,
    status: r.status as Job['status'],
    log: (r.log as string) ?? '',
    outputHashes: P(r.output_hashes, {}),
    error: P(r.error, null),
    sessionId: (r.session_id as string) ?? null,
    createdAt: r.created_at as string,
    startedAt: (r.started_at as string) ?? null,
    finishedAt: (r.finished_at as string) ?? null,
  };
}
function toEvent(r: Row): ProjectEvent {
  return {
    seq: r.seq as number,
    id: r.id as string,
    type: r.type as string,
    origin: r.origin as ProjectEvent['origin'],
    ts: r.ts as string,
    data: P(r.data, null),
  };
}
function toStale(r: Row): StaleRecord {
  return {
    artifactId: r.artifact_id as string,
    upstreamArtifactId: r.upstream_artifact_id as string,
    expectedRevisionId: (r.expected_revision_id as string) ?? null,
    actualRevisionId: (r.actual_revision_id as string) ?? null,
    path: P(r.path, []),
    reason: r.reason as StaleRecord['reason'],
    sinceEventSeq: r.since_event_seq as number,
  };
}
function toProject(r: Row): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    intent: r.intent as string,
    unitsPref: r.units_pref as string,
    currencyPref: r.currency_pref as string,
    schemaVersion: r.schema_version as number,
    createdAt: r.created_at as string,
  };
}
function toSession(r: Row): SessionInfo {
  return {
    id: r.id as string,
    adapterId: r.adapter_id as string,
    executablePath: r.executable_path as string,
    state: r.state as SessionInfo['state'],
    pid: (r.pid as number) ?? null,
    exitCode: (r.exit_code as number) ?? null,
    cols: 80,
    rows: 24,
    startedAt: (r.started_at as string) ?? null,
    endedAt: (r.ended_at as string) ?? null,
    waitingForReview: false,
    lastError: (r.last_error as string) ?? null,
  };
}

export class Repo {
  constructor(public readonly db: Database.Database) {}

  /** Run fn inside an immediate transaction. */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /* ------------------------------ project ------------------------------ */

  insertProject(p: Project): void {
    this.db
      .prepare(
        `INSERT INTO project(id,name,intent,units_pref,currency_pref,schema_version,created_at) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(p.id, p.name, p.intent, p.unitsPref, p.currencyPref, p.schemaVersion, p.createdAt);
  }
  getProject(): Project | null {
    const r = this.db.prepare(`SELECT * FROM project LIMIT 1`).get() as Row | undefined;
    return r ? toProject(r) : null;
  }
  updateProject(fields: { name?: string; intent?: string }): void {
    const p = this.getProject();
    if (!p) return;
    this.db
      .prepare(`UPDATE project SET name=?, intent=? WHERE id=?`)
      .run(fields.name ?? p.name, fields.intent ?? p.intent, p.id);
  }
  meta(key: string): string | null {
    const r = this.db.prepare(`SELECT value FROM meta WHERE key=?`).get(key) as Row | undefined;
    return (r?.value as string) ?? null;
  }
  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(key, value);
  }

  /* ------------------------------ artifacts ---------------------------- */

  insertArtifact(a: Artifact): void {
    this.db
      .prepare(
        `INSERT INTO artifact(id,type,title,subsystem,selected_revision_id,archived,created_at) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        a.id,
        a.type,
        a.title,
        a.subsystem,
        a.selectedRevisionId,
        a.archived ? 1 : 0,
        a.createdAt,
      );
  }
  getArtifact(id: string): Artifact | null {
    const r = this.db.prepare(`SELECT * FROM artifact WHERE id=?`).get(id) as Row | undefined;
    return r ? toArtifact(r) : null;
  }
  updateArtifactTitle(id: string, title: string): void {
    this.db.prepare(`UPDATE artifact SET title=? WHERE id=?`).run(title, id);
  }
  updateArtifactSubsystem(id: string, subsystem: string | null): void {
    this.db.prepare(`UPDATE artifact SET subsystem=? WHERE id=?`).run(subsystem, id);
  }
  setArchived(id: string, archived: boolean): void {
    this.db.prepare(`UPDATE artifact SET archived=? WHERE id=?`).run(archived ? 1 : 0, id);
  }
  setSelectedRevision(artifactId: string, revisionId: string | null): void {
    this.db
      .prepare(`UPDATE artifact SET selected_revision_id=? WHERE id=?`)
      .run(revisionId, artifactId);
  }
  listArtifacts(opts?: {
    type?: string;
    subsystem?: string;
    includeArchived?: boolean;
  }): Artifact[] {
    let sql = `SELECT * FROM artifact WHERE 1=1`;
    const args: unknown[] = [];
    if (opts?.type) {
      sql += ` AND type=?`;
      args.push(opts.type);
    }
    if (opts?.subsystem) {
      sql += ` AND subsystem=?`;
      args.push(opts.subsystem);
    }
    if (!opts?.includeArchived) sql += ` AND archived=0`;
    sql += ` ORDER BY created_at`;
    return (this.db.prepare(sql).all(...args) as Row[]).map(toArtifact);
  }

  /* ------------------------------ revisions ---------------------------- */

  insertRevision(r: Revision): void {
    this.db
      .prepare(
        `INSERT INTO revision(id,artifact_id,parent_id,seq,origin,origin_detail,created_at,payload,content_hash,files,inputs,rationale,review_state)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.id,
        r.artifactId,
        r.parentId,
        r.seq,
        r.origin,
        r.originDetail,
        r.createdAt,
        J(r.payload),
        r.contentHash,
        J(r.files),
        J(r.inputs),
        r.rationale,
        r.reviewState,
      );
  }
  getRevision(id: string): Revision | null {
    const r = this.db.prepare(`SELECT * FROM revision WHERE id=?`).get(id) as Row | undefined;
    return r ? toRevision(r) : null;
  }
  nextRevisionSeq(artifactId: string): number {
    const r = this.db
      .prepare(`SELECT COALESCE(MAX(seq),0)+1 AS s FROM revision WHERE artifact_id=?`)
      .get(artifactId) as Row;
    return r.s as number;
  }
  listRevisions(artifactId: string): Revision[] {
    return (
      this.db
        .prepare(`SELECT * FROM revision WHERE artifact_id=? ORDER BY seq`)
        .all(artifactId) as Row[]
    ).map(toRevision);
  }
  listDrafts(artifactId?: string): Revision[] {
    const sql = artifactId
      ? `SELECT * FROM revision WHERE artifact_id=? AND review_state='draft' ORDER BY created_at`
      : `SELECT * FROM revision WHERE review_state='draft' ORDER BY created_at`;
    const rows = artifactId
      ? (this.db.prepare(sql).all(artifactId) as Row[])
      : (this.db.prepare(sql).all() as Row[]);
    return rows.map(toRevision);
  }
  setRevisionState(id: string, state: Revision['reviewState']): void {
    this.db.prepare(`UPDATE revision SET review_state=? WHERE id=?`).run(state, id);
  }

  /* ------------------------------ edges -------------------------------- */

  insertEdge(e: Edge): void {
    this.db
      .prepare(
        `INSERT INTO edge(id,upstream_artifact_id,downstream_artifact_id,relationship,required_upstream_revision_id,label,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        e.id,
        e.upstreamArtifactId,
        e.downstreamArtifactId,
        e.relationship,
        e.requiredUpstreamRevisionId,
        e.label,
        e.createdBy,
        e.createdAt,
      );
  }
  deleteEdge(id: string): void {
    this.db.prepare(`DELETE FROM edge WHERE id=?`).run(id);
  }
  edgesFrom(artifactId: string): Edge[] {
    return (
      this.db.prepare(`SELECT * FROM edge WHERE upstream_artifact_id=?`).all(artifactId) as Row[]
    ).map(toEdge);
  }
  edgesTo(artifactId: string): Edge[] {
    return (
      this.db.prepare(`SELECT * FROM edge WHERE downstream_artifact_id=?`).all(artifactId) as Row[]
    ).map(toEdge);
  }
  allEdges(): Edge[] {
    return (this.db.prepare(`SELECT * FROM edge`).all() as Row[]).map(toEdge);
  }

  /* ------------------------------ proposals/decisions ------------------ */

  insertProposal(p: Proposal): void {
    this.db
      .prepare(
        `INSERT INTO proposal(id,changes,reason,impact,state,created_by,created_by_session,created_at) VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        p.id,
        J(p.changes),
        p.reason,
        J(p.impact ?? null),
        p.state,
        p.createdBy,
        p.createdBySession,
        p.createdAt,
      );
  }
  getProposal(id: string): Proposal | null {
    const r = this.db.prepare(`SELECT * FROM proposal WHERE id=?`).get(id) as Row | undefined;
    return r ? toProposal(r) : null;
  }
  updateProposalState(id: string, state: Proposal['state'], rationale?: string): void {
    this.db
      .prepare(`UPDATE proposal SET state=?, resolved_at=?, resolution_rationale=? WHERE id=?`)
      .run(state, new Date().toISOString(), rationale ?? null, id);
  }
  listProposals(state?: string): Proposal[] {
    const rows = state
      ? (this.db
          .prepare(`SELECT * FROM proposal WHERE state=? ORDER BY created_at DESC`)
          .all(state) as Row[])
      : (this.db.prepare(`SELECT * FROM proposal ORDER BY created_at DESC`).all() as Row[]);
    return rows.map(toProposal);
  }
  pendingProposalForArtifact(artifactId: string): Proposal | null {
    const rows = this.db.prepare(`SELECT * FROM proposal WHERE state='pending'`).all() as Row[];
    for (const r of rows) {
      const p = toProposal(r);
      if (p.changes.some((c) => c.artifactId === artifactId)) return p;
    }
    return null;
  }

  insertDecision(d: Decision): void {
    this.db
      .prepare(
        `INSERT INTO decision(id,proposal_id,action,actor,ts,rationale,prior_baseline,new_baseline,event_seq) VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        d.id,
        d.proposalId,
        d.action,
        d.actor,
        d.ts,
        d.rationale,
        J(d.priorBaseline),
        J(d.newBaseline),
        d.eventSeq,
      );
  }
  listDecisions(limit = 200): Decision[] {
    return (
      this.db.prepare(`SELECT * FROM decision ORDER BY ts DESC LIMIT ?`).all(limit) as Row[]
    ).map(toDecision);
  }

  /* ------------------------------ bom / offers ------------------------- */

  insertBomLine(l: BomLine): void {
    this.db
      .prepare(
        `INSERT INTO bom_line(id,component_artifact_id,component_revision_id,subsystem,quantity,offer_id,location,notes) VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        l.id,
        l.componentArtifactId,
        l.componentRevisionId,
        l.subsystem,
        l.quantity,
        l.offerId,
        l.location,
        l.notes,
      );
  }
  updateBomLine(
    id: string,
    fields: Partial<
      Pick<BomLine, 'quantity' | 'offerId' | 'location' | 'notes' | 'componentRevisionId'>
    >,
  ): void {
    const cur = this.getBomLine(id);
    if (!cur) return;
    this.db
      .prepare(
        `UPDATE bom_line SET quantity=?, offer_id=?, location=?, notes=?, component_revision_id=? WHERE id=?`,
      )
      .run(
        fields.quantity ?? cur.quantity,
        fields.offerId !== undefined ? fields.offerId : cur.offerId,
        fields.location !== undefined ? fields.location : cur.location,
        fields.notes ?? cur.notes,
        fields.componentRevisionId ?? cur.componentRevisionId,
        id,
      );
  }
  deleteBomLine(id: string): void {
    this.db.prepare(`DELETE FROM bom_line WHERE id=?`).run(id);
  }
  getBomLine(id: string): BomLine | null {
    const r = this.db.prepare(`SELECT * FROM bom_line WHERE id=?`).get(id) as Row | undefined;
    return r ? toBomLine(r) : null;
  }
  listBomLines(): BomLine[] {
    return (this.db.prepare(`SELECT * FROM bom_line ORDER BY subsystem, id`).all() as Row[]).map(
      toBomLine,
    );
  }
  bomLinesForComponent(componentArtifactId: string): BomLine[] {
    return (
      this.db
        .prepare(`SELECT * FROM bom_line WHERE component_artifact_id=?`)
        .all(componentArtifactId) as Row[]
    ).map(toBomLine);
  }

  insertOffer(o: Offer, componentArtifactId: string): void {
    this.db
      .prepare(
        `INSERT INTO offer(id,component_artifact_id,seller,url,price_amount,price_currency,quantity_basis,availability_text,observed_at,source_id) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        o.id,
        componentArtifactId,
        o.seller,
        o.url ?? null,
        o.price?.amount ?? null,
        o.price?.currency ?? null,
        o.quantityBasis,
        o.availabilityText ?? null,
        o.observedAt,
        o.sourceId ?? null,
      );
  }
  getOffer(id: string): (Offer & { componentArtifactId: string }) | null {
    const r = this.db.prepare(`SELECT * FROM offer WHERE id=?`).get(id) as Row | undefined;
    return r ? { ...toOffer(r), componentArtifactId: r.component_artifact_id as string } : null;
  }
  offersForComponent(componentArtifactId: string): Offer[] {
    return (
      this.db
        .prepare(`SELECT * FROM offer WHERE component_artifact_id=? ORDER BY observed_at DESC`)
        .all(componentArtifactId) as Row[]
    ).map(toOffer);
  }

  /* ------------------------------ jobs --------------------------------- */

  insertJob(j: Job): void {
    this.db
      .prepare(
        `INSERT INTO job(id,kind,tool,tool_version,inputs,input_hashes,command,status,log,output_hashes,error,session_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        j.id,
        j.kind,
        j.tool,
        j.toolVersion,
        J(j.inputs),
        J(j.inputHashes),
        j.command,
        j.status,
        j.log,
        J(j.outputHashes),
        J(j.error),
        j.sessionId,
        j.createdAt,
      );
  }
  updateJob(
    id: string,
    fields: Partial<
      Pick<
        Job,
        | 'status'
        | 'log'
        | 'outputHashes'
        | 'error'
        | 'startedAt'
        | 'finishedAt'
        | 'toolVersion'
        | 'command'
      >
    >,
  ): void {
    const cur = this.getJob(id);
    if (!cur) return;
    this.db
      .prepare(
        `UPDATE job SET status=?, log=?, output_hashes=?, error=?, started_at=?, finished_at=?, tool_version=?, command=? WHERE id=?`,
      )
      .run(
        fields.status ?? cur.status,
        fields.log ?? cur.log,
        J(fields.outputHashes ?? cur.outputHashes),
        J(fields.error !== undefined ? fields.error : cur.error),
        fields.startedAt ?? cur.startedAt,
        fields.finishedAt ?? cur.finishedAt,
        fields.toolVersion ?? cur.toolVersion,
        fields.command ?? cur.command,
        id,
      );
  }
  appendJobLog(id: string, chunk: string, maxChars: number): void {
    this.db
      .prepare(`UPDATE job SET log = substr(log || ?, -?) WHERE id=?`)
      .run(chunk, maxChars, id);
  }
  getJob(id: string): Job | null {
    const r = this.db.prepare(`SELECT * FROM job WHERE id=?`).get(id) as Row | undefined;
    return r ? toJob(r) : null;
  }
  listJobs(limit = 50, status?: string): Job[] {
    const rows = status
      ? (this.db
          .prepare(`SELECT * FROM job WHERE status=? ORDER BY created_at DESC LIMIT ?`)
          .all(status, limit) as Row[])
      : (this.db.prepare(`SELECT * FROM job ORDER BY created_at DESC LIMIT ?`).all(limit) as Row[]);
    return rows.map(toJob);
  }

  /* ------------------------------ events ------------------------------- */

  /** Append an event inside the current transaction; returns its seq. */
  appendEvent(
    type: string,
    origin: 'user' | 'agent' | 'system',
    data: unknown,
    id?: string,
  ): number {
    const r = this.db
      .prepare(`INSERT INTO event(id,type,origin,ts,data) VALUES(?,?,?,?,?)`)
      .run(id ?? newId(), type, origin, new Date().toISOString(), J(data));
    return Number(r.lastInsertRowid);
  }
  eventsSince(seq: number, limit = 500): ProjectEvent[] {
    return (
      this.db
        .prepare(`SELECT * FROM event WHERE seq>? ORDER BY seq LIMIT ?`)
        .all(seq, limit) as Row[]
    ).map(toEvent);
  }
  latestEventSeq(): number {
    const r = this.db.prepare(`SELECT COALESCE(MAX(seq),0) AS s FROM event`).get() as Row;
    return r.s as number;
  }
  listEvents(limit = 200): ProjectEvent[] {
    return (
      this.db.prepare(`SELECT * FROM event ORDER BY seq DESC LIMIT ?`).all(limit) as Row[]
    ).map(toEvent);
  }

  /* ------------------------------ stale -------------------------------- */

  replaceStale(artifactId: string, records: StaleRecord[]): void {
    this.db.prepare(`DELETE FROM stale WHERE artifact_id=?`).run(artifactId);
    const ins = this.db.prepare(
      `INSERT INTO stale(artifact_id,upstream_artifact_id,expected_revision_id,actual_revision_id,path,reason,since_event_seq) VALUES(?,?,?,?,?,?,?)`,
    );
    for (const s of records) {
      ins.run(
        s.artifactId,
        s.upstreamArtifactId,
        s.expectedRevisionId,
        s.actualRevisionId,
        J(s.path),
        s.reason,
        s.sinceEventSeq,
      );
    }
  }
  clearStale(artifactId: string): void {
    this.db.prepare(`DELETE FROM stale WHERE artifact_id=?`).run(artifactId);
  }
  staleFor(artifactId: string): StaleRecord[] {
    return (
      this.db.prepare(`SELECT * FROM stale WHERE artifact_id=?`).all(artifactId) as Row[]
    ).map(toStale);
  }
  allStale(): StaleRecord[] {
    return (this.db.prepare(`SELECT * FROM stale`).all() as Row[]).map(toStale);
  }

  /* ------------------------------ materialization ---------------------- */

  addMaterialization(path: string, sha256: string | null, revisionId: string | null): string {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO materialization(id,path,sha256,revision_id,state,created_at) VALUES(?,?,?,?,'pending',?)`,
      )
      .run(id, path, sha256, revisionId, new Date().toISOString());
    return id;
  }
  completeMaterialization(id: string): void {
    this.db.prepare(`UPDATE materialization SET state='done' WHERE id=?`).run(id);
  }
  pendingMaterializations(): {
    id: string;
    path: string;
    sha256: string | null;
    revisionId: string | null;
  }[] {
    return (
      this.db.prepare(`SELECT * FROM materialization WHERE state='pending'`).all() as Row[]
    ).map((r) => ({
      id: r.id as string,
      path: r.path as string,
      sha256: (r.sha256 as string) ?? null,
      revisionId: (r.revision_id as string) ?? null,
    }));
  }

  /* ------------------------------ idempotency -------------------------- */

  getIdempotent(key: string): { requestHash: string; response: unknown } | null {
    const r = this.db.prepare(`SELECT * FROM idempotency WHERE key=?`).get(key) as Row | undefined;
    return r ? { requestHash: r.request_hash as string, response: P(r.response, null) } : null;
  }
  putIdempotent(key: string, requestHash: string, response: unknown): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO idempotency(key,request_hash,response,created_at) VALUES(?,?,?,?)`,
      )
      .run(key, requestHash, J(response), new Date().toISOString());
  }

  /* ------------------------------ sessions ----------------------------- */

  upsertSession(s: SessionInfo): void {
    this.db
      .prepare(
        `INSERT INTO session(id,adapter_id,executable_path,state,pid,exit_code,started_at,ended_at,last_error)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET state=excluded.state, pid=excluded.pid, exit_code=excluded.exit_code, started_at=excluded.started_at, ended_at=excluded.ended_at, last_error=excluded.last_error`,
      )
      .run(
        s.id,
        s.adapterId,
        s.executablePath,
        s.state,
        s.pid,
        s.exitCode,
        s.startedAt,
        s.endedAt,
        s.lastError,
      );
  }
  getSession(id: string): SessionInfo | null {
    const r = this.db.prepare(`SELECT * FROM session WHERE id=?`).get(id) as Row | undefined;
    return r ? toSession(r) : null;
  }
  sessionsByState(state: string): SessionInfo[] {
    return (this.db.prepare(`SELECT * FROM session WHERE state=?`).all(state) as Row[]).map(
      toSession,
    );
  }

  /* ------------------------------ fts ---------------------------------- */

  ftsIndex(artifactId: string, revisionId: string, title: string, text: string): void {
    this.db.prepare(`DELETE FROM artifact_fts WHERE artifact_id=?`).run(artifactId);
    this.db
      .prepare(`INSERT INTO artifact_fts(artifact_id,revision_id,title,text) VALUES(?,?,?,?)`)
      .run(artifactId, revisionId, title, text);
  }
  ftsSearch(
    query: string,
    limit = 20,
  ): { artifactId: string; revisionId: string; title: string; snippet: string }[] {
    const rows = this.db
      .prepare(
        `SELECT artifact_id, revision_id, title, snippet(artifact_fts, 3, '«', '»', '…', 12) AS snip
         FROM artifact_fts WHERE artifact_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(query, limit) as Row[];
    return rows.map((r) => ({
      artifactId: r.artifact_id as string,
      revisionId: r.revision_id as string,
      title: r.title as string,
      snippet: r.snip as string,
    }));
  }
}
