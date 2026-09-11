/** SQL migrations, applied in order inside a transaction each. */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
PRAGMA foreign_keys = ON;

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT '',
  units_pref TEXT NOT NULL DEFAULT 'si',
  currency_pref TEXT NOT NULL DEFAULT 'USD',
  schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE artifact (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  subsystem TEXT,
  selected_revision_id TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE revision (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifact(id),
  parent_id TEXT,
  seq INTEGER NOT NULL,
  origin TEXT NOT NULL,
  origin_detail TEXT,
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  inputs TEXT NOT NULL DEFAULT '[]',
  rationale TEXT NOT NULL DEFAULT '',
  review_state TEXT NOT NULL DEFAULT 'draft',
  UNIQUE(artifact_id, seq)
);
CREATE INDEX idx_revision_artifact ON revision(artifact_id);
CREATE INDEX idx_revision_state ON revision(review_state);

CREATE TABLE edge (
  id TEXT PRIMARY KEY,
  upstream_artifact_id TEXT NOT NULL REFERENCES artifact(id),
  downstream_artifact_id TEXT NOT NULL REFERENCES artifact(id),
  relationship TEXT NOT NULL,
  required_upstream_revision_id TEXT,
  label TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_edge_up ON edge(upstream_artifact_id);
CREATE INDEX idx_edge_down ON edge(downstream_artifact_id);

CREATE TABLE proposal (
  id TEXT PRIMARY KEY,
  changes TEXT NOT NULL,
  reason TEXT NOT NULL,
  impact TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  created_by TEXT NOT NULL,
  created_by_session TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_rationale TEXT
);

CREATE TABLE decision (
  id TEXT PRIMARY KEY,
  proposal_id TEXT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  ts TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  prior_baseline TEXT NOT NULL DEFAULT '[]',
  new_baseline TEXT NOT NULL DEFAULT '[]',
  event_seq INTEGER NOT NULL
);
CREATE INDEX idx_decision_ts ON decision(ts);

CREATE TABLE bom_line (
  id TEXT PRIMARY KEY,
  component_artifact_id TEXT NOT NULL REFERENCES artifact(id),
  component_revision_id TEXT NOT NULL,
  subsystem TEXT,
  quantity REAL NOT NULL,
  offer_id TEXT,
  location TEXT,
  notes TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_bom_component ON bom_line(component_artifact_id);

CREATE TABLE offer (
  id TEXT PRIMARY KEY,
  component_artifact_id TEXT NOT NULL REFERENCES artifact(id),
  seller TEXT NOT NULL,
  url TEXT,
  price_amount TEXT,
  price_currency TEXT,
  quantity_basis REAL NOT NULL DEFAULT 1,
  availability_text TEXT,
  observed_at TEXT NOT NULL,
  source_id TEXT
);
CREATE INDEX idx_offer_component ON offer(component_artifact_id);

CREATE TABLE job (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  tool TEXT NOT NULL,
  tool_version TEXT,
  inputs TEXT NOT NULL DEFAULT 'null',
  input_hashes TEXT NOT NULL DEFAULT '{}',
  command TEXT,
  status TEXT NOT NULL,
  log TEXT NOT NULL DEFAULT '',
  output_hashes TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_job_status ON job(status);

CREATE TABLE event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  origin TEXT NOT NULL,
  ts TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT 'null'
);
CREATE INDEX idx_event_type ON event(type);

CREATE TABLE stale (
  artifact_id TEXT NOT NULL REFERENCES artifact(id),
  upstream_artifact_id TEXT NOT NULL,
  expected_revision_id TEXT,
  actual_revision_id TEXT,
  path TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  since_event_seq INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, upstream_artifact_id)
);
CREATE INDEX idx_stale_artifact ON stale(artifact_id);

CREATE TABLE materialization (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  sha256 TEXT,
  revision_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE idempotency (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  adapter_id TEXT NOT NULL,
  executable_path TEXT NOT NULL,
  state TEXT NOT NULL,
  pid INTEGER,
  exit_code INTEGER,
  started_at TEXT,
  ended_at TEXT,
  last_error TEXT
);

CREATE VIRTUAL TABLE artifact_fts USING fts5(
  artifact_id UNINDEXED,
  revision_id UNINDEXED,
  title,
  text
);
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
