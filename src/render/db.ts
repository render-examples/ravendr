import { Pool, type PoolClient } from "pg";
import type { PhaseEvent } from "../shared/events.js";
import type { ResearchSource } from "../shared/ports.js";
import { AppError } from "../shared/errors.js";

let pool: Pool | null = null;

export function getPool(connectionString: string): Pool {
  if (pool) return pool;
  pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  pool.on("error", () => {
    // pg swallows connection errors if the listener is missing.
  });
  return pool;
}

export async function withClient<T>(
  connectionString: string,
  fn: (c: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool(connectionString).connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// ─── sessions ───────────────────────────────────────────────────────
export interface Session {
  id: string;
  topic: string | null;
  createdAt: Date;
  status: "open" | "researching" | "complete" | "error";
}

export async function createSession(
  db: string,
  topic: string | null
): Promise<Session> {
  return withClient(db, async (c) => {
    const res = await c.query<{ id: string; created_at: Date }>(
      `INSERT INTO sessions (topic, status) VALUES ($1, 'open') RETURNING id, created_at`,
      [topic]
    );
    const row = res.rows[0];
    if (!row) throw new AppError("DB", "failed to create session");
    return { id: row.id, topic, createdAt: row.created_at, status: "open" };
  });
}

export async function setSessionTopic(
  db: string,
  sessionId: string,
  topic: string
): Promise<void> {
  await withClient(db, (c) =>
    c.query(`UPDATE sessions SET topic = $1 WHERE id = $2`, [topic, sessionId])
  );
}

export async function setSessionStatus(
  db: string,
  sessionId: string,
  status: Session["status"]
): Promise<void> {
  await withClient(db, (c) =>
    c.query(`UPDATE sessions SET status = $1 WHERE id = $2`, [status, sessionId])
  );
}

// ─── briefings ──────────────────────────────────────────────────────
export interface Briefing {
  id: string;
  sessionId: string;
  runId: string | null;
  topic: string;
  content: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export async function createBriefing(
  db: string,
  sessionId: string,
  topic: string,
  runId: string | null
): Promise<string> {
  return withClient(db, async (c) => {
    const res = await c.query<{ id: string }>(
      `INSERT INTO briefings (session_id, topic, run_id) VALUES ($1, $2, $3) RETURNING id`,
      [sessionId, topic, runId]
    );
    const row = res.rows[0];
    if (!row) throw new AppError("DB", "failed to create briefing");
    return row.id;
  });
}

export async function completeBriefing(
  db: string,
  briefingId: string,
  content: string
): Promise<void> {
  await withClient(db, (c) =>
    c.query(
      `UPDATE briefings SET content = $1, completed_at = now() WHERE id = $2`,
      [content, briefingId]
    )
  );
}

export async function getBriefing(
  db: string,
  briefingId: string
): Promise<Briefing | null> {
  return withClient(db, async (c) => {
    const res = await c.query<{
      id: string;
      session_id: string;
      run_id: string | null;
      topic: string;
      content: string | null;
      created_at: Date;
      completed_at: Date | null;
    }>(
      `SELECT id, session_id, run_id, topic, content, created_at, completed_at
       FROM briefings WHERE id = $1`,
      [briefingId]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      runId: row.run_id,
      topic: row.topic,
      content: row.content,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    };
  });
}

// ─── sources ────────────────────────────────────────────────────────
export async function addSources(
  db: string,
  briefingId: string,
  sources: ResearchSource[]
): Promise<void> {
  if (sources.length === 0) return;
  await withClient(db, async (c) => {
    const values = sources
      .map(
        (_, i) =>
          `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`
      )
      .join(",");
    const params: (string | null)[] = [briefingId];
    for (const s of sources) {
      params.push(s.url, s.title, s.snippet ?? null);
    }
    await c.query(
      `INSERT INTO sources (briefing_id, url, title, snippet) VALUES ${values}
       ON CONFLICT (briefing_id, url) DO NOTHING`,
      params
    );
  });
}

export async function listSources(
  db: string,
  briefingId: string
): Promise<ResearchSource[]> {
  return withClient(db, async (c) => {
    const res = await c.query<{ url: string; title: string; snippet: string | null }>(
      `SELECT url, title, snippet FROM sources WHERE briefing_id = $1 ORDER BY created_at ASC`,
      [briefingId]
    );
    return res.rows.map((r) => ({
      url: r.url,
      title: r.title,
      snippet: r.snippet ?? undefined,
    }));
  });
}

// ─── phase event log (audit trail) ──────────────────────────────────
export async function recordPhaseEvent(
  db: string,
  event: PhaseEvent
): Promise<void> {
  await withClient(db, (c) =>
    c.query(
      `INSERT INTO phase_events (session_id, kind, payload) VALUES ($1, $2, $3)`,
      [event.sessionId, event.kind, JSON.stringify(event)]
    )
  );
}

export async function listPhaseEvents(
  db: string,
  sessionId: string
): Promise<PhaseEvent[]> {
  return withClient(db, async (c) => {
    const res = await c.query<{ payload: PhaseEvent }>(
      `SELECT payload FROM phase_events WHERE session_id = $1 ORDER BY at ASC`,
      [sessionId]
    );
    return res.rows.map((r) => r.payload);
  });
}
