import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { curateFeedback, GENERAL_SCOPE, memoryDecision, normalizeCandidate, normalizeText, selectMemories } from './memory.js';

const schema = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('bootstrap', 'conversation')),
  topic TEXT NOT NULL,
  style TEXT NOT NULL CHECK (style IN ('explore', 'debate')),
  language TEXT NOT NULL CHECK (language IN ('en', 'ko')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,
  review TEXT,
  memory_version_snapshot TEXT NOT NULL,
  context_eligible INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS utterances (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  start_ms INTEGER,
  end_ms INTEGER,
  stream_id TEXT,
  in_roleplay INTEGER NOT NULL DEFAULT 0,
  transcript_status TEXT NOT NULL DEFAULT 'clear' CHECK (transcript_status IN ('clear', 'uncertain')),
  UNIQUE(session_id, event_id)
);
CREATE INDEX IF NOT EXISTS utterances_by_session ON utterances(session_id, seq);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  scope TEXT NOT NULL,
  assertion TEXT NOT NULL CHECK (assertion IN ('explicit', 'inferred')),
  status TEXT NOT NULL CHECK (status IN ('active', 'candidate', 'deleted')),
  version INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(kind, key, scope)
);
CREATE TABLE IF NOT EXISTS memory_evidence (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  utterance_id TEXT NOT NULL REFERENCES utterances(id) ON DELETE CASCADE,
  quote TEXT NOT NULL,
  PRIMARY KEY (memory_id, version, utterance_id)
);
CREATE TABLE IF NOT EXISTS memory_revisions (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  value TEXT NOT NULL,
  status TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (memory_id, version)
);
CREATE TABLE IF NOT EXISTS learning_observations (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  utterance_id TEXT NOT NULL REFERENCES utterances(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL,
  original TEXT NOT NULL,
  suggestion TEXT NOT NULL,
  why TEXT NOT NULL,
  PRIMARY KEY (session_id, pattern)
);
`;

function sessionOutput(row) {
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    topic: row.topic,
    style: row.style,
    language: row.language,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    summary: row.summary,
    review: row.review ? JSON.parse(row.review) : null
  };
}

function memoryOutput(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    key: row.key,
    value: row.value,
    scope: row.scope,
    assertion: row.assertion,
    status: row.status,
    version: row.version,
    validFrom: row.valid_from,
    updatedAt: row.updated_at
  };
}

function utteranceOutput(row) {
  return {
    id: row.id,
    role: row.role,
    text: row.text,
    startMs: row.start_ms,
    endMs: row.end_ms,
    inRoleplay: Boolean(row.in_roleplay),
    transcriptStatus: row.transcript_status
  };
}

function canStitch(previous, part) {
  return previous?.role === part.role && previous.endMs !== null &&
    part.startMs >= previous.startMs && part.startMs - previous.endMs <= 850 &&
    previous.inRoleplay === part.inRoleplay && previous.transcriptStatus === part.transcriptStatus;
}

function stitchUtterances(rows) {
  const utterances = [];
  let fragments = [];
  let streamId;
  function flush() {
    const spans = [];
    for (const part of fragments.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
      const previous = spans.at(-1);
      if (canStitch(previous, part)) {
        previous.text += part.text;
        previous.endMs = Math.max(previous.endMs, part.endMs);
      } else {
        spans.push({ ...part });
      }
    }
    utterances.push(...spans);
    fragments = [];
  }
  for (const row of rows) {
    const part = utteranceOutput(row);
    if (part.startMs !== null) {
      if (fragments.length && streamId !== row.stream_id) flush();
      streamId = row.stream_id;
      fragments.push(part);
    } else {
      flush();
      utterances.push(part);
    }
  }
  flush();
  return utterances;
}

function error(message, status) {
  return Object.assign(new Error(message), { status, statusCode: status });
}

function normalizeEvent(event) {
  if (!event || (event.role !== 'user' && event.role !== 'assistant') ||
    typeof event.text !== 'string' || event.text.length > 16000) throw error('Invalid transcript event.', 400);
  const startMs = event.startMs ?? null;
  const endMs = event.endMs ?? null;
  if ((startMs === null) !== (endMs === null) ||
    (startMs !== null && (!Number.isSafeInteger(startMs) || startMs < 0 || !Number.isSafeInteger(endMs) || endMs < startMs))) {
    throw error('Invalid transcript timing.', 400);
  }
  if (event.eventId !== undefined && (typeof event.eventId !== 'string' || !event.eventId || event.eventId.length > 200)) {
    throw error('Invalid transcript event identifier.', 400);
  }
  if (event.streamId !== undefined && (typeof event.streamId !== 'string' || !event.streamId || event.streamId.length > 120)) {
    throw error('Invalid transcript stream identifier.', 400);
  }
  return {
    eventId: event.eventId ?? randomUUID(),
    role: event.role,
    text: startMs === null ? event.text.trim() : event.text,
    startMs,
    endMs,
    streamId: event.streamId ?? null,
    inRoleplay: event.inRoleplay === true ? 1 : 0,
    transcriptStatus: event.transcriptStatus === 'uncertain' ? 'uncertain' : 'clear'
  };
}

export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
  db.exec(schema);

  const now = () => new Date().toISOString();
  const sessionRow = (id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  const memoryRow = (id) => db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  const findMemory = ({ kind, key, scope }) => db.prepare(
    'SELECT * FROM memories WHERE kind = ? AND key = ? AND scope = ?'
  ).get(kind, key, scope);

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (cause) {
      db.exec('ROLLBACK');
      throw cause;
    }
  }

  function listUtterances(id) {
    return stitchUtterances(db.prepare('SELECT * FROM utterances WHERE session_id = ? ORDER BY seq').all(id));
  }

  function addEvidence(id, version, evidence) {
    const insert = db.prepare('INSERT OR IGNORE INTO memory_evidence VALUES (?, ?, ?, ?)');
    for (const utterance of evidence) insert.run(id, version, utterance.id, utterance.text.slice(0, 800));
  }

  function snapshot(row, reason, date) {
    db.prepare('INSERT INTO memory_revisions VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.version, row.value, row.status, row.valid_from, date, reason);
  }

  function replaceMemory(row, { value, assertion, status, reason, evidence = [] }, date) {
    snapshot(row, reason, date);
    const version = row.version + 1;
    db.prepare('UPDATE memories SET value = ?, assertion = ?, status = ?, version = ?, valid_from = ?, updated_at = ? WHERE id = ?')
      .run(value, assertion, status, version, date, date, row.id);
    addEvidence(row.id, version, evidence);
  }

  function forgetMemory(row) {
    if (row) {
      db.prepare("UPDATE memories SET value = NULL, status = 'deleted', version = version + 1, updated_at = ? WHERE id = ?")
        .run(now(), row.id);
      db.prepare('DELETE FROM memory_evidence WHERE memory_id = ?').run(row.id);
      db.prepare('DELETE FROM memory_revisions WHERE memory_id = ?').run(row.id);
    }
    // Generated summaries may paraphrase forgotten material. Hide prior summaries
    // from context while keeping the user-visible conversation history intact.
    db.exec('UPDATE sessions SET context_eligible = 0');
  }

  function applyCandidate(candidate, date, sourceVersions, sessionId) {
    const current = findMemory(candidate);
    if (current?.status === 'deleted') {
      // A later interview can mention a deleted topic again. A fresh summary
      // should not bypass the restriction on using that memory.
      db.prepare('UPDATE sessions SET context_eligible = 0 WHERE id = ?').run(sessionId);
    }
    const action = memoryDecision(current, candidate);
    if (action === 'ignore') return null;
    if (current && sourceVersions[current.id] !== current.version && ['forget', 'update', 'activate'].includes(action)) {
      return { kind: candidate.kind, value: candidate.value, action: 'conflict' };
    }
    if (action === 'forget') {
      if (!current) {
        db.prepare(`INSERT INTO memories (id, kind, key, scope, assertion, status, valid_from, updated_at)
          VALUES (?, ?, ?, ?, 'explicit', 'deleted', ?, ?)`)
          .run(randomUUID(), candidate.kind, candidate.key, candidate.scope, date, date);
      }
      forgetMemory(current);
      return { kind: candidate.kind, value: 'Removed from memory', action };
    }
    if (action === 'keep') {
      addEvidence(current.id, current.version, candidate.evidence);
      return null;
    }
    if (action === 'conflict') return { kind: candidate.kind, value: candidate.value, action };
    if (action === 'update' || action === 'activate') {
      replaceMemory(current, { ...candidate, status: 'active', reason: action }, date);
    } else {
      const id = randomUUID();
      const status = action === 'hold' ? 'candidate' : 'active';
      db.prepare(`INSERT INTO memories (id, kind, key, value, scope, assertion, status, valid_from, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, candidate.kind, candidate.key, candidate.value, candidate.scope, candidate.assertion, status, date, date);
      addEvidence(id, 1, candidate.evidence);
    }
    return { kind: candidate.kind, value: candidate.value, action };
  }

  function withEvidence(row) {
    const memory = memoryOutput(row);
    if (!memory) return null;
    memory.evidence = db.prepare(`SELECT e.utterance_id AS utteranceId, u.session_id AS sessionId, e.quote
      FROM memory_evidence e JOIN utterances u ON u.id = e.utterance_id
      WHERE e.memory_id = ? AND e.version = ? ORDER BY u.seq DESC LIMIT 5`).all(memory.id, memory.version)
      .map((entry) => ({ ...entry }));
    return memory;
  }

  return {
    close: () => db.close(),

    createSession({ mode, topic = '', style = 'explore', language = 'en' }) {
      if (!['bootstrap', 'conversation'].includes(mode) || !['explore', 'debate'].includes(style) ||
          !['en', 'ko'].includes(language) || typeof topic !== 'string' || topic.length > 300) {
        throw error('Invalid conversation settings.', 400);
      }
      const id = randomUUID();
      return transaction(() => {
        const versions = db.prepare("SELECT id, version FROM memories WHERE status <> 'deleted'").all();
        const snapshot = JSON.stringify(Object.fromEntries(versions.map(({ id, version }) => [id, version])));
        db.prepare(`INSERT INTO sessions (id, mode, topic, style, language, started_at, memory_version_snapshot)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, mode, topic.trim(), style, language, now(), snapshot);
        return sessionOutput(sessionRow(id));
      });
    },

    getSession: (id) => sessionOutput(sessionRow(id)),

    listSessions(limit = 50) {
      const cappedLimit = Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50;
      return db.prepare('SELECT * FROM sessions ORDER BY started_at DESC, rowid DESC LIMIT ?').all(cappedLimit).map(sessionOutput);
    },

    listUtterances,

    appendUtterances(id, events) {
      if (!Array.isArray(events) || events.length > 200) throw error('Invalid transcript event batch.', 400);
      const normalized = events.map(normalizeEvent);
      return transaction(() => {
        const row = sessionRow(id);
        if (!row) throw error('Conversation not found.', 404);
        if (row.status !== 'active') throw error('This conversation has ended.', 409);
        const append = db.prepare(`INSERT INTO utterances (
          id, session_id, event_id, role, text, start_ms, end_ms, stream_id, in_roleplay, transcript_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, event_id) DO NOTHING RETURNING *`);
        const inserted = normalized.flatMap((event) => {
          if (!event.text) return [];
          const record = append.get(randomUUID(), id, event.eventId, event.role, event.text, event.startMs,
            event.endMs, event.streamId, event.inRoleplay, event.transcriptStatus);
          return record ? [utteranceOutput(record)] : [];
        });
        return { accepted: inserted.length, utterances: inserted };
      });
    },

    endSession(id, review = {}, candidates = []) {
      return transaction(() => {
        const row = sessionRow(id);
        if (!row) throw error('Conversation not found.', 404);
        if (row.status === 'ended') {
          const session = sessionOutput(row);
          return { session, review: session.review };
        }
        const utterances = new Map(listUtterances(id).filter((item) => item.role === 'user').map((item) => [item.id, item]));
        const date = now();
        const sourceVersions = JSON.parse(row.memory_version_snapshot);
        const changes = [];
        const seen = new Set();
        for (const rawCandidate of Array.isArray(candidates) ? candidates.slice(0, 20) : []) {
          const candidate = normalizeCandidate(rawCandidate, utterances);
          if (!candidate) continue;
          const key = `${candidate.kind}/${candidate.key}/${candidate.scope}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const change = applyCandidate(candidate, date, sourceVersions, id);
          if (change) changes.push(change);
        }
        const summary = typeof review.summary === 'string' ? review.summary.trim().slice(0, 2000) : '';
        const openQuestion = typeof review.openQuestion === 'string' ? review.openQuestion.trim().slice(0, 500) : '';
        const feedback = curateFeedback(review.feedback, utterances);
        const addObservation = db.prepare('INSERT OR IGNORE INTO learning_observations VALUES (?, ?, ?, ?, ?, ?)');
        for (const item of feedback) {
          addObservation.run(id, item.evidenceId, normalizeText(item.suggestion), item.original, item.suggestion, item.why);
        }
        const rendered = { summary, openQuestion, feedback, changes };
        db.prepare("UPDATE sessions SET status = 'ended', ended_at = ?, summary = ?, review = ? WHERE id = ?")
          .run(date, summary, JSON.stringify(rendered), id);
        return { session: sessionOutput(sessionRow(id)), review: rendered };
      });
    },

    needsBootstrap() {
      return !db.prepare(`SELECT 1 FROM sessions s
        WHERE s.mode = 'bootstrap' AND s.status = 'ended'
          AND EXISTS (SELECT 1 FROM utterances u WHERE u.session_id = s.id AND u.role = 'user' AND trim(u.text) <> '')
        LIMIT 1`).get();
    },

    listMemories() {
      return db.prepare("SELECT * FROM memories WHERE status <> 'deleted' ORDER BY updated_at DESC, rowid DESC LIMIT 500")
        .all().map(withEvidence);
    },

    patchMemory(id, { value, version } = {}) {
      if (typeof value !== 'string' || !value.trim() || value.trim().length > 1200 ||
        (version !== undefined && (!Number.isInteger(version) || version < 1))) {
        throw error('A memory needs a value of 1–1200 characters and a valid version.', 400);
      }
      return transaction(() => {
        const row = memoryRow(id);
        if (!row || row.status === 'deleted') return null;
        if (version !== undefined && version !== row.version) throw error('This memory has changed. Refresh and try again.', 409);
        if (row.value === value.trim() && row.status === 'active') return withEvidence(row);
        replaceMemory(row, { value: value.trim(), assertion: 'explicit', status: 'active', reason: 'manual_edit' }, now());
        return withEvidence(memoryRow(id));
      });
    },

    deleteMemory(id) {
      return transaction(() => {
        const row = memoryRow(id);
        if (!row || row.status === 'deleted') return false;
        forgetMemory(row);
        return true;
      });
    },

    getContext({ topic = '', scope = GENERAL_SCOPE, sessionId } = {}) {
      const pool = db.prepare("SELECT * FROM memories WHERE status = 'active' ORDER BY updated_at DESC, rowid DESC LIMIT 500")
        .all().map(memoryOutput);
      const memories = selectMemories(pool, topic, scope);
      const recentSessions = db.prepare(`SELECT * FROM sessions
        WHERE status = 'ended' AND context_eligible = 1 AND id <> ?
        AND EXISTS (SELECT 1 FROM utterances WHERE session_id = sessions.id AND role = 'user')
        ORDER BY ended_at DESC, rowid DESC LIMIT 3`).all(sessionId ?? '')
        .map((row) => {
          const session = sessionOutput(row);
          return { id: session.id, topic: session.topic, summary: session.summary, openQuestion: session.review?.openQuestion, endedAt: session.endedAt };
        });
      const learning = db.prepare(`SELECT l.suggestion, COUNT(*) AS occurrences
        FROM learning_observations l JOIN sessions s ON s.id = l.session_id
        WHERE s.context_eligible = 1 GROUP BY l.pattern HAVING COUNT(*) >= 2
        ORDER BY MAX(s.ended_at) DESC LIMIT 3`).all();
      return { memories, recentSessions, learning };
    }
  };
}
