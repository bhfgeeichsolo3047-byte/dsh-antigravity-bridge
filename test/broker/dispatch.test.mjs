import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROKER = path.resolve(HERE, '..', '..', 'broker', 'broker.mjs');

// broker 对 /relay 的 timeoutMs 有硬下限 10s（broker.mjs: Math.max(..., 10_000)），
// 所以测试里凡是「等 /relay 自己超时」的断言都要按 10s 以上算，socket 超时给到 20s。
const RELAY_TIMEOUT_MS = 60_000;

function freePort() {
  return 19000 + Math.floor(Math.random() * 2000);
}

function get(port, urlPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ timeout: true }); });
    req.on('error', (e) => resolve({ error: e.message }));
  });
}

// 返回 { promise, abort }：abort 用于「只关心一侧结果，不想等 /relay 自己 10s 超时」的场景。
function post(port, urlPath, payload, timeoutMs) {
  const data = JSON.stringify(payload);
  let req = null;
  let settle = () => {};
  const promise = new Promise((resolve) => {
    settle = resolve;
    req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST', timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ timeout: true }); });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(data);
    req.end();
  });
  return {
    promise,
    abort: () => {
      try { req.destroy(); } catch { /* ignore */ }
      settle({ aborted: true });
    },
  };
}

async function startBroker() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-broker-'));
  const dataDir = path.join(home, '.dsh', 'agy-collab');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'state.json'),
    JSON.stringify({ enabled: true, sessions: { 'test-session': true }, updatedAt: Date.now() }),
  );
  const port = freePort();
  const child = spawn(process.execPath, [BROKER], {
    env: { ...process.env, USERPROFILE: home, HOME: home, DSH_AGY_COLLAB_PORT: String(port) },
    stdio: 'ignore',
    windowsHide: true,
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const res = await get(port, '/health', 800);
    if (res.status === 200) return { port, child, home };
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill();
  throw new Error('broker did not become healthy in time');
}

function stopBroker(handle) {
  try { handle.child.kill(); } catch { /* ignore */ }
  try { fs.rmSync(handle.home, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('broker: 新 /relay 请求会在 waiter 注册后被唤醒的 /listen 立刻取到（派发死锁回归）', async () => {
  const handle = await startBroker();
  try {
    const listenP = get(handle.port, '/listen?timeout=4000', 8000);
    await new Promise((r) => setTimeout(r, 250));
    const relay = post(handle.port, '/relay', {
      sessionId: 'test-session',
      phase: 'consult',
      task: 'dispatch regression probe',
      context: 'unit test',
      workspace: process.cwd(),
      timeoutMs: RELAY_TIMEOUT_MS,
    }, 20_000);

    const listenRes = await listenP;
    assert.equal(listenRes.status, 200);
    const listenBody = JSON.parse(listenRes.body);
    assert.equal(listenBody.ok, true);
    assert.equal(listenBody.hasRequest, true, '/listen 必须在 /relay 之后被唤醒并拿到请求');
    assert.equal(listenBody.count, 1);
    assert.equal(listenBody.request.sessionId, 'test-session');
    assert.match(listenBody.request.requestId, /^req_/);
    relay.abort();
  } finally {
    stopBroker(handle);
  }
});

test('broker: 同会话新请求会作废旧请求，旧请求调用方立刻收到 superseded', async () => {
  const handle = await startBroker();
  try {
    const first = post(handle.port, '/relay', {
      sessionId: 'test-session',
      phase: 'plan',
      task: 'first request',
      context: '',
      workspace: process.cwd(),
      timeoutMs: RELAY_TIMEOUT_MS,
    }, 20_000);
    await new Promise((r) => setTimeout(r, 400));

    const second = post(handle.port, '/relay', {
      sessionId: 'test-session',
      phase: 'plan',
      task: 'second request',
      context: '',
      workspace: process.cwd(),
      timeoutMs: RELAY_TIMEOUT_MS,
    }, 20_000);

    const firstRes = await first.promise;
    const firstBody = JSON.parse(firstRes.body);
    assert.equal(firstBody.superseded, true, '旧请求必须被标记为 superseded');
    assert.equal(firstBody.ok, false);
    second.abort();
  } finally {
    stopBroker(handle);
  }
});

test('broker: 协作开关关闭时 /relay 直接拒绝，不建 backlog', async () => {
  const handle = await startBroker();
  try {
    const dataDir = path.join(handle.home, '.dsh', 'agy-collab');
    fs.writeFileSync(
      path.join(dataDir, 'state.json'),
      JSON.stringify({ enabled: false, sessions: {}, updatedAt: Date.now() }),
    );
    const res = await post(handle.port, '/relay', {
      sessionId: 'other-session',
      phase: 'plan',
      task: 'should be rejected',
      context: '',
      workspace: process.cwd(),
      timeoutMs: 2000,
    }, 8000).promise;
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.disabled, true);

    const status = await get(handle.port, '/status', 2000);
    const statusBody = JSON.parse(status.body);
    assert.equal(statusBody.pendingCount, 0);
  } finally {
    stopBroker(handle);
  }
});

test('broker: POST /state 保留 state.json 里的 v2 字段（丢键回归）', async () => {
  const handle = await startBroker();
  try {
    const dataDir = path.join(handle.home, '.dsh', 'agy-collab');
    const v2Fields = {
      schema_version: 2,
      brokerPort: 18765,
      workspaceRoot: 'C:/tmp/ws',
      role_binding_mode: 'triple',
      reviewer_mode: 'strict',
      rejection_limit: 2,
      estimate_subagents: false,
      roles: {
        planner: { carrier: 'in-process', model: null, actor_id: null },
        executor: { carrier: 'session', model: null, actor_id: null },
        reviewer: { carrier: 'in-process', model: null, actor_id: null },
      },
    };
    fs.writeFileSync(
      path.join(dataDir, 'state.json'),
      JSON.stringify({ ...v2Fields, enabled: true, sessions: { 'test-session': true }, updatedAt: 1 }, null, 2),
    );

    const res = await post(handle.port, '/state', { sessionId: 'test-session', enabled: false }, 8000).promise;
    assert.equal(res.status, 200);

    const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    for (const [k, v] of Object.entries(v2Fields)) {
      assert.deepEqual(after[k], v, `字段 ${k} 被 broker 抹掉了`);
    }
    assert.equal(after.enabled, false);
    assert.equal(after.sessions['test-session'], false);
  } finally {
    stopBroker(handle);
  }
});
