/**
 * Antigravity (A) <-> DeepSeek Harness (D) Local Network Collaboration Broker
 * Runs silently in the background on 127.0.0.1:18765.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.DSH_AGY_COLLAB_PORT || 18765);
const HOST = process.env.DSH_AGY_COLLAB_HOST || '127.0.0.1';
const DATA_DIR = path.join(os.homedir(), '.dsh', 'agy-collab');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');
const PID_FILE = path.join(DATA_DIR, 'broker.pid');
const MAX_RECORDS = 3;
const MAX_HISTORY_LINES = 6;
const MAX_DOC_FILES = 3;
const BATCH_WINDOW_MS = Number(process.env.DSH_AGY_BATCH_WINDOW_MS || 250);
const STALE_REDISPATCH_MS = Number(process.env.DSH_AGY_STALE_MS || 180_000);

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      enabled: Boolean(raw.enabled),
      sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
      updatedAt: Number(raw.updatedAt) || Date.now(),
    };
  } catch {
    return {
      enabled: false,
      sessions: {},
      updatedAt: Date.now(),
    };
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch {
    // ignore transient write errors
  }
}

function loadRecords() {
  try {
    const raw = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf8'));
    if (Array.isArray(raw)) {
      return raw.slice(-MAX_RECORDS);
    }
    if (raw && Array.isArray(raw.records)) {
      return raw.records.slice(-MAX_RECORDS);
    }
  } catch {
    // ignore missing or corrupt file
  }
  return [];
}

function saveRecords(list) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const trimmed = list.slice(-MAX_RECORDS);
    const tmp = `${RECORDS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, RECORDS_FILE);
  } catch {
    // ignore transient write errors
  }
}

function pruneHistoryFile(keepLines = MAX_HISTORY_LINES) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    if (keepLines <= 0) {
      fs.writeFileSync(HISTORY_FILE, '', 'utf8');
      return;
    }
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= keepLines) return;
    const trimmed = lines.slice(-keepLines).join('\n') + '\n';
    const tmp = `${HISTORY_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, trimmed, 'utf8');
    fs.renameSync(tmp, HISTORY_FILE);
  } catch {
    // ignore
  }
}

function pruneOldTaskDocs(keepCount = MAX_DOC_FILES) {
  try {
    const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
    const docs = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(md|tmp)$/i.test(entry.name)) continue;
      if (/^(state|records|history)\.(json|jsonl)\./i.test(entry.name)) continue;
      const fullPath = path.join(DATA_DIR, entry.name);
      try {
        const st = fs.statSync(fullPath);
        docs.push({ fullPath, mtimeMs: st.mtimeMs });
      } catch {
        // ignore
      }
    }
    docs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const obsolete = docs.slice(Math.max(0, keepCount));
    for (const f of obsolete) {
      try {
        fs.unlinkSync(f.fullPath);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function appendHistory(entry) {
  try {
    fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
    pruneHistoryFile(MAX_HISTORY_LINES);
  } catch {
    // ignore
  }
}

let collabState = loadState();
let recordsList = loadRecords();

function toPublicRecord(r) {
  return {
    requestId: r.requestId,
    sessionId: r.sessionId || '',
    phase: r.phase || 'plan',
    workspace: r.workspace || '',
    createdAt: Number(r.createdAt) || Date.now(),
    repliedAt: r.repliedAt ? Number(r.repliedAt) : null,
    status: r.status || 'pending',
    dToA: {
      task: r.dToA?.task ?? r.task ?? '',
      context: r.dToA?.context ?? r.context ?? '',
      executionReport: r.dToA?.executionReport ?? r.executionReport ?? '',
    },
    aToD: r.aToD
      ? {
          verdict: r.aToD.verdict || '',
          content: r.aToD.content || '',
        }
      : r.reply
        ? {
            verdict: r.reply.verdict || '',
            content: r.reply.content || '',
          }
        : null,
  };
}

/**
 * Map of requestId -> {
 *   requestId, sessionId, phase, task, context, executionReport, workspace,
 *   createdAt, repliedAt, status: 'pending' | 'delivered_to_a' | 'replied',
 *   reply: null | object,
 *   dWaiters: Array<(reply) => void>
 * }
 */
const requests = new Map();

function pruneRequestsMap(keepReplied = MAX_RECORDS) {
  const repliedKeys = [];
  for (const [k, v] of requests.entries()) {
    if (v.status === 'replied') repliedKeys.push(k);
  }
  while (repliedKeys.length > Math.max(0, keepReplied)) {
    const oldest = repliedKeys.shift();
    if (oldest) requests.delete(oldest);
  }
}

function upsertRecord(record) {
  const pub = toPublicRecord(record);
  const idx = recordsList.findIndex((item) => item.requestId === pub.requestId);
  if (idx >= 0) {
    recordsList[idx] = pub;
  } else {
    recordsList.push(pub);
  }
  if (recordsList.length > MAX_RECORDS) {
    recordsList = recordsList.slice(-MAX_RECORDS);
  }
  saveRecords(recordsList);
  pruneOldTaskDocs(MAX_DOC_FILES);
  pruneRequestsMap(MAX_RECORDS);
}

// Enforce 3-record / 3-doc retention immediately at broker startup
saveRecords(recordsList);
pruneHistoryFile(MAX_HISTORY_LINES);
pruneOldTaskDocs(MAX_DOC_FILES);

/**
 * Queue of listener callbacks from Agent A (`GET /listen`) waiting for eligible pending requests.
 */
const aListeners = new Set();

function isEligibleForDispatch(r, now = Date.now()) {
  if (!r || r.status === 'replied') return false;
  if (!r.dispatched) return true;
  const age = now - (Number(r.dispatchedAt) || Number(r.createdAt) || 0);
  return age >= STALE_REDISPATCH_MS;
}

function hasEligibleRequest(now = Date.now()) {
  for (const r of requests.values()) {
    if (isEligibleForDispatch(r, now)) return true;
  }
  return false;
}

function serializeRequestForA(r) {
  return {
    requestId: r.requestId,
    sessionId: r.sessionId,
    phase: r.phase,
    task: r.task,
    context: r.context,
    executionReport: r.executionReport,
    workspace: r.workspace,
    createdAt: r.createdAt,
  };
}

function claimEligibleBatch(maxBatch = 20) {
  const now = Date.now();
  const batch = [];
  for (const r of requests.values()) {
    if (isEligibleForDispatch(r, now)) {
      r.status = 'delivered_to_a';
      r.dispatched = true;
      r.dispatchedAt = now;
      upsertRecord(r);
      batch.push(serializeRequestForA(r));
      if (batch.length >= maxBatch) break;
    }
  }
  return batch;
}

function notifyAListeners() {
  if (aListeners.size === 0) return;
  if (!hasEligibleRequest()) return;
  for (const listener of [...aListeners]) {
    aListeners.delete(listener);
    try {
      listener();
      break;
    } catch {
      // ignore and try next listener
    }
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(body);
}

async function readBody(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) throw new Error('Request body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function isSessionEnabled(sessionId) {
  collabState = loadState();
  if (sessionId && Object.prototype.hasOwnProperty.call(collabState.sessions, sessionId)) {
    return Boolean(collabState.sessions[sessionId]);
  }
  return Boolean(collabState.enabled);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store',
    });
    res.end();
    return;
  }

  let url;
  try {
    url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid URL' });
    return;
  }

  const pathname = url.pathname;

  try {
    // 1. Health & status
    if (pathname === '/health' || pathname === '/status') {
      const sessionId = url.searchParams.get('sessionId') || '';
      const pendingList = [...requests.values()]
        .filter((r) => r.status !== 'replied')
        .map((r) => ({
          requestId: r.requestId,
          sessionId: r.sessionId,
          phase: r.phase,
          status: r.status,
          createdAt: r.createdAt,
        }));
      sendJson(res, 200, {
        ok: true,
        brokerOnline: true,
        pid: process.pid,
        port: PORT,
        enabled: isSessionEnabled(sessionId),
        globalEnabled: Boolean(collabState.enabled),
        aListening: aListeners.size > 0,
        pendingCount: pendingList.length,
        pending: pendingList,
        recordsCount: recordsList.length,
      });
      return;
    }

    // 2. Get or toggle collaboration switch state
    if (pathname === '/state') {
      if (req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') || '';
        const pendingList = [...requests.values()].filter((r) => r.status !== 'replied');
        sendJson(res, 200, {
          ok: true,
          brokerOnline: true,
          enabled: isSessionEnabled(sessionId),
          globalEnabled: Boolean(collabState.enabled),
          aListening: aListeners.size > 0,
          pendingCount: pendingList.length,
          records: recordsList,
        });
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        collabState = loadState();
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        const nextEnabled = typeof body.enabled === 'boolean'
          ? body.enabled
          : !isSessionEnabled(sessionId);
        // Update both global default and session-specific state so new and active sessions stay in sync
        collabState.enabled = nextEnabled;
        if (sessionId) {
          collabState.sessions[sessionId] = nextEnabled;
        }
        // Also update all existing session entries unless stickyPerSession is requested
        if (body.scope !== 'session-only') {
          for (const k of Object.keys(collabState.sessions)) {
            collabState.sessions[k] = nextEnabled;
          }
        }
        collabState.updatedAt = Date.now();
        saveState(collabState);
        appendHistory({ event: 'toggle', sessionId, enabled: nextEnabled });
        sendJson(res, 200, {
          ok: true,
          brokerOnline: true,
          enabled: nextEnabled,
          globalEnabled: collabState.enabled,
          aListening: aListeners.size > 0,
          records: recordsList,
        });
        return;
      }
    }

    // 2b. Full collaboration records endpoints
    if (pathname === '/records' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        records: recordsList,
      });
      return;
    }

    if (pathname === '/records/clear' && req.method === 'POST') {
      recordsList = [];
      saveRecords(recordsList);
      pruneHistoryFile(0);
      pruneOldTaskDocs(0);
      pruneRequestsMap(0);
      sendJson(res, 200, {
        ok: true,
        records: [],
      });
      return;
    }

    // 3. D -> A Relay endpoint (blocks until A replies or timeout)
    if (pathname === '/relay' && req.method === 'POST') {
      const body = await readBody(req);
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      const force = body.force === true;
      if (!force && !isSessionEnabled(sessionId)) {
        sendJson(res, 200, {
          ok: false,
          disabled: true,
          error: 'A↔D 协作开关当前处于关闭状态，无需后台转达，请直接独立完成任务。',
        });
        return;
      }

      const phase = body.phase === 'review' ? 'review' : body.phase === 'consult' ? 'consult' : 'plan';
      const task = String(body.task || '').trim();
      const context = String(body.context || '').trim();
      const executionReport = String(body.executionReport || body.execution_report || '').trim();
      const workspace = String(body.workspace || '').trim();
      const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 480_000, 10_000), 600_000);
      const requestId = typeof body.requestId === 'string' && body.requestId.trim()
        ? body.requestId.trim()
        : `req_${Date.now()}_${randomUUID().slice(0, 8)}`;

      const record = {
        requestId,
        sessionId,
        phase,
        task,
        context,
        executionReport,
        workspace,
        createdAt: Date.now(),
        repliedAt: null,
        status: 'pending',
        dispatched: false,
        dispatchedAt: 0,
        reply: null,
        dWaiters: [],
      };
      requests.set(requestId, record);
      upsertRecord(record);
      appendHistory({
        event: 'relay_from_d',
        requestId,
        sessionId,
        phase,
        task: task.slice(0, 500),
        workspace,
      });

      // Immediately wake up Agent A's background listener if waiting
      notifyAListeners();

      // Wait for Agent A's reply
      const reply = await new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve({
            ok: false,
            timeout: true,
            requestId,
            error: `等待 Agent A (Antigravity) 响应超时 (${Math.round(timeoutMs / 1000)}s)。请确认 Antigravity 后台监听任务正在运行。`,
          });
        }, timeoutMs);

        const waiter = (r) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(r);
        };
        record.dWaiters.push(waiter);

        req.on('close', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
        });
      });

      sendJson(res, 200, reply);
      return;
    }

    // 4. Agent A's long-polling listener (`GET /listen`) with micro-batch coalescing
    if (pathname === '/listen' && req.method === 'GET') {
      const timeoutMs = Math.min(Math.max(Number(url.searchParams.get('timeout')) || 300_000, 500), 600_000);
      const maxBatch = Math.min(Math.max(Number(url.searchParams.get('maxBatch')) || 20, 1), 50);
      const rawBatchWindow = url.searchParams.get('batchWindowMs');
      const batchWindowMs = Math.min(
        Math.max(rawBatchWindow !== null ? Number(rawBatchWindow) : BATCH_WINDOW_MS, 0),
        2000,
      );

      let reqClosed = false;
      const markClosed = () => {
        if (!res.writableEnded) reqClosed = true;
      };
      req.on('aborted', markClosed);
      res.on('close', markClosed);

      if (!hasEligibleRequest()) {
        const wokeUp = await new Promise((resolve) => {
          let settled = false;
          let listener = null;
          let timer = null;
          let staleCheckTimer = null;

          const finish = (val) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (staleCheckTimer) clearInterval(staleCheckTimer);
            if (listener) aListeners.delete(listener);
            resolve(val);
          };

          listener = () => finish(true);
          timer = setTimeout(() => finish(false), timeoutMs);
          staleCheckTimer = setInterval(() => {
            if (hasEligibleRequest()) finish(true);
          }, 2000);

          aListeners.add(listener);
          req.on('aborted', () => finish(false));
          res.on('close', () => {
            if (!res.writableEnded) finish(false);
          });
        });

        if (!wokeUp || reqClosed) {
          if (!res.writableEnded) {
            sendJson(res, 200, { ok: true, hasRequest: false, timeout: true });
          }
          return;
        }
      }

      // Micro-batch coalescing window: wait briefly so concurrent /relay calls arrive together
      if (batchWindowMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, batchWindowMs));
      }

      if (reqClosed || res.writableEnded) {
        return;
      }

      const batch = claimEligibleBatch(maxBatch);
      if (batch.length === 0) {
        sendJson(res, 200, { ok: true, hasRequest: false, timeout: true });
        return;
      }

      if (hasEligibleRequest() && aListeners.size > 0) {
        notifyAListeners();
      }

      sendJson(res, 200, {
        ok: true,
        hasRequest: true,
        count: batch.length,
        request: batch[0],
        requests: batch,
      });
      return;
    }

    // 5. Agent A -> D Reply endpoint (`POST /reply`)
    if (pathname === '/reply' && req.method === 'POST') {
      const body = await readBody(req);
      let requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
      let record = requestId ? requests.get(requestId) : null;
      if (!record) {
        // Fallback: reply to the oldest unreplied request
        for (const r of requests.values()) {
          if (r.status !== 'replied') {
            record = r;
            requestId = r.requestId;
            break;
          }
        }
      }
      if (!record) {
        sendJson(res, 404, { ok: false, error: '没有找到待回复的 DSH 协作请求' });
        return;
      }

      const verdict = body.verdict || (record.phase === 'plan' ? 'PLAN_READY' : record.phase === 'consult' ? 'CONSULT_ANSWERED' : 'APPROVED');
      const content = String(body.content || body.reply || '').trim();
      const repliedAt = Date.now();
      const replyPayload = {
        ok: true,
        requestId: record.requestId,
        phase: record.phase,
        verdict,
        content,
        repliedAt,
      };

      record.status = 'replied';
      record.repliedAt = repliedAt;
      record.reply = replyPayload;
      upsertRecord(record);
      appendHistory({
        event: 'reply_from_a',
        requestId: record.requestId,
        phase: record.phase,
        verdict,
        content: content.slice(0, 500),
      });

      for (const waiter of record.dWaiters.splice(0)) {
        try {
          waiter(replyPayload);
        } catch {
          // ignore
        }
      }

      pruneRequestsMap(MAX_RECORDS);

      sendJson(res, 200, { ok: true, delivered: true, requestId: record.requestId, verdict });
      return;
    }

    // 6. Recent history
    if (pathname === '/history' && req.method === 'GET') {
      let lines = [];
      try {
        const raw = fs.readFileSync(HISTORY_FILE, 'utf8').trim();
        if (raw) {
          lines = raw
            .split('\n')
            .slice(-MAX_HISTORY_LINES)
            .map((l) => {
              try { return JSON.parse(l); } catch { return null; }
            })
            .filter(Boolean);
        }
      } catch {
        lines = [];
      }
      sendJson(res, 200, { ok: true, history: lines });
      return;
    }

    sendJson(res, 404, { ok: false, error: `Unknown endpoint: ${pathname}` });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err?.message || err) });
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    // Already running on this port
    process.exit(0);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch {
    // ignore
  }
  console.log(`[agy-collab-broker] listening on http://${HOST}:${PORT} (pid=${process.pid})`);
});
