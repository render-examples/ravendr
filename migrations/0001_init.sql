-- ravendr v2 schema.
-- Mastra's own tables live in the `mastra` schema (managed by @mastra/pg).

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── sessions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  topic       text,
  status      text NOT NULL CHECK (status IN ('open','researching','complete','error')) DEFAULT 'open',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_created_at_idx ON sessions (created_at DESC);

-- ── briefings ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS briefings (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id        text,
  topic         text NOT NULL,
  content       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS briefings_session_id_idx ON briefings (session_id);

-- ── sources ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sources (
  id           bigserial PRIMARY KEY,
  briefing_id  uuid NOT NULL REFERENCES briefings(id) ON DELETE CASCADE,
  url          text NOT NULL,
  title        text NOT NULL,
  snippet      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (briefing_id, url)
);

CREATE INDEX IF NOT EXISTS sources_briefing_id_idx ON sources (briefing_id);

-- ── phase events (audit trail; also published via NOTIFY) ─────────
CREATE TABLE IF NOT EXISTS phase_events (
  id          bigserial PRIMARY KEY,
  session_id  uuid NOT NULL,
  kind        text NOT NULL,
  payload     jsonb NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS phase_events_session_id_at_idx ON phase_events (session_id, at);
