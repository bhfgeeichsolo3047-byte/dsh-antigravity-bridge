/**
 * Antigravity (A) <-> DeepSeek Harness (D) Local Network Collaboration Broker
 * Runs silently in the background on 127.0.0.1:18765.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

/** 自家签名：Host 侧据此判断「端口上跑的是不是我们这份 broker」（规格 §10.2 第 2 步）。 */
const SERVICE_NAME = 'dsh-agy-collab-broker';
const PID_SCHEMA_VERSION = 1;

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
/** 空闲自退阈值（规格 §10.5）：最后一个监听者断开且无待回复请求，满 30 分钟自退。 */
const IDLE_EXIT_MS = Number(process.env.DSH_AGY_IDLE_EXIT_MS || 30 * 60_000);

fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * 本次开机的 boot-id（6 位十六进制）。
 * 与 plugin/dsh-agy-collab/lib/v2/config.js 的 resolveBootId 同一算法：
 * 同一开机的所有进程算出同一个值，重启必然变化，无需平台 API。
 * broker 会被单独复制到 ~/.dsh/agy-collab/ 运行，不能 import 插件模块，故本地重写一份。
 */
function resolveBootId() {
  const bootMs = Date.now() - os.uptime() * 1000;
  const minute = Math.round(bootMs / 60000);
  return createHash('sha256').update(String(minute)).digest('hex').slice(0, 6);
}

const BOOT_ID = resolveBootId();
const STARTED_AT = Date.now();

/**
 * broker.pid 升级为 JSON 归属记录（规格 §10.4）。
 * 三个用途：复用判据（/health 不通但 pid 活着且 startedAt 吻合 → 认为正在启动）/
 * 残留清理（pid 不存在或 bootId 不匹配 → 上次开机遗留，删）/ 设置页显示。
 */
function writePidFile() {
  const payload = {
    service: SERVICE_NAME,
    schemaVersion: PID_SCHEMA_VERSION,
    pid: process.pid,
    port: PORT,
    startedAt: STARTED_AT,
    bootId: BOOT_ID,
  };
  try {
    const tmp = `${PID_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, PID_FILE);
  } catch {
    // ignore
  }
}

/**
 * 退出时清掉自己的归属记录：只删属于本进程的那一份。
 * 不判断归属就删，会把后来启动的另一个 broker 的 pid 文件误删。
 */
function removePidFileIfOwn() {
  try {
    const raw = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    if (raw && Number(raw.pid) === process.pid && Number(raw.startedAt) === STARTED_AT) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    // ignore
  }
}

/**
 * 读 state.json 的完整原始对象（含 v2 的 schema_version / roles / workspaceRoot 等键）。
 * 读失败返回空对象。**任何写盘都必须以它为底合并**，否则会把 v2 配置整文件抹掉。
 */
function readRawState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  } catch {
    // ignore
  }
  return {};
}

function loadState() {
  const raw = readRawState();
  return {
    ...raw,
    enabled: Boolean(raw.enabled),
    sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function saveState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // 写前重新读一次盘上原文件做底：并发写者（Host 侧 lib/index.js）刚落的 v2 键不能被这次覆盖丢掉。
    const merged = { ...readRawState(), ...state };
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8');
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
    role: r.role ?? ((r.phase || 'plan') === 'review' ? 'reviewer' : 'planner'),
    phase: r.phase || 'plan',
    round: r.round ?? 1,
    stage: r.stage || '',
    cold: r.cold === true,
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

function pruneStaleBacklog(now = Date.now()) {
  for (const [k, r] of requests.entries()) {
    if (!r || r.status === 'replied') continue;
    // Only expiry prunes. 'no waiters' is NOT a prune reason: a record is briefly
    // waiter-less between requests.set() and record.dWaiters.push(), and pruning on
    // that window silently killed every in-flight /relay.
    const expired = now - (Number(r.createdAt) || 0) > (Number(r.timeoutMs) || 480_000);
    if (expired) {
      requests.delete(k);
    }
  }
}

function isEligibleForDispatch(r, now = Date.now()) {
  if (!r || r.status === 'replied') return false;
  if (!Array.isArray(r.dWaiters) || r.dWaiters.length === 0) return false;
  if (now - (Number(r.createdAt) || 0) > (Number(r.timeoutMs) || 480_000)) return false;
  if (!r.dispatched) return true;
  const age = now - (Number(r.dispatchedAt) || Number(r.createdAt) || 0);
  return age >= STALE_REDISPATCH_MS;
}

function hasEligibleRequest(now = Date.now()) {
  pruneStaleBacklog(now);
  for (const r of requests.values()) {
    if (isEligibleForDispatch(r, now)) return true;
  }
  return false;
}

/**
 * A 侧看到的形状。role / round / stage / cold 是 v2 路由依据（§9.1），
 * phase 与 legacyPhase 只用于兼容与排错，A 不该再按 phase 做判断。
 */
function serializeRequestForA(r) {
  return {
    requestId: r.requestId,
    sessionId: r.sessionId,
    role: r.role ?? (r.phase === 'review' ? 'reviewer' : 'planner'),
    phase: r.phase,
    legacyPhase: r.legacyPhase === true,
    round: r.round ?? 1,
    stage: r.stage || '',
    cold: r.cold === true,
    roleBinding: r.roleBinding || '',
    estimateSubagents: r.estimateSubagents === true,
    task: r.task,
    context: r.context,
    executionReport: r.executionReport,
    workspace: r.workspace,
    createdAt: r.createdAt,
  };
}

function claimEligibleBatch(maxBatch = 20) {
  const now = Date.now();
  pruneStaleBacklog(now);
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
  // 除只读探活外，任何一次交互都算活动：空闲自退的计时器靠它复位（§10.5）。
  if (pathname !== '/health' && pathname !== '/status') touchActivity();

  try {
    // 1. Health & status
    if (pathname === '/health' || pathname === '/status') {
      pruneStaleBacklog();
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
        // 自家签名：Host 侧只认这个字段判断「端口上跑的是不是我们这份 broker」（§10.2 第 2 步）。
        service: SERVICE_NAME,
        schemaVersion: PID_SCHEMA_VERSION,
        brokerOnline: true,
        pid: process.pid,
        port: PORT,
        bootId: BOOT_ID,
        startedAt: STARTED_AT,
        uptimeMs: Date.now() - STARTED_AT,
        idleExitMs: IDLE_EXIT_MS,
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
        pruneStaleBacklog();
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

      /**
       * 语义层已从 phase 迁到 role（规格 §9.1）：路由依据是 role=planner|reviewer。
       * phase 降级为被忽略的别名，只为让还没升级的调用方继续能用 —— 映射关系
       * plan→planner、consult→planner（consult 阶段已删，需求不清走 blocked）、
       * review→reviewer。真正传了 role 时一律以 role 为准。
       */
      const roleRaw = String(body.role || '').trim().toLowerCase();
      let role;
      let legacyPhase = false;
      if (roleRaw === 'planner' || roleRaw === 'reviewer') {
        role = roleRaw;
      } else {
        legacyPhase = true;
        role = body.phase === 'review' ? 'reviewer' : 'planner';
      }
      // phase 仍写进 record：看板与 /records 的既有读法不变，但它不再是路由依据。
      const phase = role === 'reviewer' ? 'review' : 'plan';
      const round = Math.max(1, Number(body.round) || 1);
      const cold = body.cold === true;
      const stage = String(body.stage || '').trim();
      const roleBinding = String(body.roleBinding || body.role_binding || '').trim();
      const estimateSubagents = body.estimateSubagents === true || body.estimate_subagents === true;
      const task = String(body.task || '').trim();
      const context = String(body.context || '').trim();
      const executionReport = String(body.executionReport || body.execution_report || '').trim();
      const workspace = String(body.workspace || '').trim();
      const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 480_000, 10_000), 600_000);
      const requestId = typeof body.requestId === 'string' && body.requestId.trim()
        ? body.requestId.trim()
        : `req_${Date.now()}_${randomUUID().slice(0, 8)}`;

      // 同会话新请求到达时自动作废旧的未回复请求，避免积压
      if (sessionId) {
        for (const [oldId, oldRec] of requests.entries()) {
          if (oldRec && oldRec.sessionId === sessionId && oldRec.status !== 'replied') {
            oldRec.status = 'superseded';
            for (const waiter of oldRec.dWaiters.splice(0)) {
              try {
                waiter({
                  ok: false,
                  superseded: true,
                  requestId: oldRec.requestId,
                  error: '同会话已发起新协作请求，旧请求自动作废。',
                });
              } catch {
                // ignore
              }
            }
            appendHistory({ event: 'drop_backlog', requestId: oldId, reason: 'superseded' });
            requests.delete(oldId);
          }
        }
      }

      const record = {
        requestId,
        sessionId,
        role,
        phase,
        legacyPhase,
        round,
        cold,
        stage,
        roleBinding,
        estimateSubagents,
        task,
        context,
        executionReport,
        workspace,
        timeoutMs,
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
        role,
        phase,
        legacyPhase,
        round,
        cold,
        task: task.slice(0, 500),
        workspace,
      });

      // NOTE: notifyAListeners() moved below, AFTER record.dWaiters.push(waiterFn).
      // Calling it here used to prune the brand-new record (dWaiters was still empty)
      // and deadlock every /relay request until timeout.

      // Wait for Agent A's reply; drop immediately if caller times out or disconnects
      const reply = await new Promise((resolve) => {
        let settled = false;
        let waiterFn = null;
        let timer = null;

        const dropWaiter = (reason) => {
          if (Array.isArray(record.dWaiters) && waiterFn) {
            const idx = record.dWaiters.indexOf(waiterFn);
            if (idx >= 0) record.dWaiters.splice(idx, 1);
          }
          if (record.status !== 'replied' && (!record.dWaiters || record.dWaiters.length === 0)) {
            record.status = reason;
            appendHistory({ event: 'drop_backlog', requestId, reason });
            requests.delete(requestId);
          }
        };

        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          dropWaiter('timeout_dropped');
          resolve({
            ok: false,
            timeout: true,
            requestId,
            error: `等待 Agent A (Antigravity) 响应超时 (${Math.round(timeoutMs / 1000)}s)。请确认 Antigravity 后台监听任务正在运行。`,
          });
        }, timeoutMs);

        waiterFn = (r) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(r);
        };
        record.dWaiters.push(waiterFn);
        // Wake Agent A only once the waiter exists, otherwise pruneStaleBacklog drops this record.
        notifyAListeners();

        const onDisconnect = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          dropWaiter('disconnected_dropped');
          resolve({
            ok: false,
            aborted: true,
            requestId,
            error: '请求连接已断开，自动丢弃未完成任务。',
          });
        };

        req.on('aborted', onDisconnect);
        res.on('close', () => {
          if (!res.writableEnded) onDisconnect();
        });
      });

      if (!res.writableEnded) {
        sendJson(res, 200, reply);
      }
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

      /**
       * §9.3：/reply 只剩「本轮结束」信号。
       * 不再按 phase 猜 verdict（旧的 PLAN_READY / CONSULT_ANSWERED / APPROVED 全部删除），
       * 也不再解析 content —— 真正的结论在 Workspace 的 04 / 06 文件里，Host 自己去读。
       * verdict 只做透传：调用方传什么就带什么，不传就是 null，broker 不替它编。
       */
      const verdict = typeof body.verdict === 'string' && body.verdict.trim() ? body.verdict.trim() : null;
      const handledIn = typeof body.handledIn === 'string' && body.handledIn.trim()
        ? body.handledIn.trim()
        : (typeof body.handled_in === 'string' && body.handled_in.trim() ? body.handled_in.trim() : null);
      const content = String(body.content || body.reply || '').trim();
      const repliedAt = Date.now();
      const replyPayload = {
        ok: true,
        requestId: record.requestId,
        role: record.role ?? null,
        phase: record.phase,
        round: record.round ?? 1,
        verdict,
        handledIn,
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
        role: record.role ?? null,
        phase: record.phase,
        verdict,
        handledIn,
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

      sendJson(res, 200, {
        ok: true,
        delivered: true,
        requestId: record.requestId,
        role: record.role ?? null,
        verdict,
        handledIn,
      });
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

/**
 * 端口被占用时**不再静默退出**（规格 §12.4）。
 * 先探一次 /health 判断占用者是不是我们自己的另一份 broker：
 *   - 是自家 → 说明已经有实例在跑，本进程无事可做，正常退出 0；
 *   - 是异己 → 打印可诊断的错误并以 2 退出，让 Host 侧能上抛「端口被其他程序占用」。
 */
function probeOccupant(cb) {
  const req = http.get(`http://${HOST}:${PORT}/health`, { timeout: 1000 }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        cb(body && body.service === SERVICE_NAME ? 'self' : 'foreign');
      } catch {
        cb('foreign');
      }
    });
  });
  req.on('error', () => cb('unknown'));
  req.on('timeout', () => {
    req.destroy();
    cb('unknown');
  });
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    probeOccupant((kind) => {
      if (kind === 'self') {
        console.log(
          `[agy-collab-broker] 端口 ${PORT} 已有本服务的另一实例在跑，本次启动退出（pid=${process.pid}）`,
        );
        process.exit(0);
      }
      console.error(
        `[agy-collab-broker] 端口 ${PORT} 被其他程序占用（占用者不是 ${SERVICE_NAME}）。` +
          '请在设置页改端口或关闭占用它的程序。',
      );
      process.exit(2);
    });
    return;
  }
  console.error(`[agy-collab-broker] 启动失败：${err?.message || err}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  writePidFile();
  console.log(
    `[agy-collab-broker] listening on http://${HOST}:${PORT} (pid=${process.pid}, bootId=${BOOT_ID})`,
  );
});

/**
 * 机器级服务的空闲自退（规格 §10.5）。
 * 判据三条同时成立才计时：没有 A 侧监听者、没有待回复请求、距最后一次活动超过阈值。
 * 只要还有监听者或挂着的请求就绝不退 —— 退掉会把外部角色瞬间断线。
 */
let lastActivityAt = Date.now();
const touchActivity = () => {
  lastActivityAt = Date.now();
};

setInterval(() => {
  if (aListeners.size > 0) {
    touchActivity();
    return;
  }
  const pending = [...requests.values()].filter((r) => r && r.status !== 'replied');
  if (pending.length > 0) {
    touchActivity();
    return;
  }
  if (Date.now() - lastActivityAt >= IDLE_EXIT_MS) {
    console.log(`[agy-collab-broker] 空闲 ${Math.round(IDLE_EXIT_MS / 60000)} 分钟，自动退出（pid=${process.pid}）`);
    shutdown(0);
  }
}, Math.min(60_000, Math.max(1000, Math.floor(IDLE_EXIT_MS / 4)))).unref?.();

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  removePidFileIfOwn();
  try {
    server.close();
  } catch {
    // ignore
  }
  // 兜底：server.close() 等长连接自然结束时可能永不回调
  setTimeout(() => process.exit(code), 200).unref?.();
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => shutdown(0));
}
process.on('exit', () => removePidFileIfOwn());
