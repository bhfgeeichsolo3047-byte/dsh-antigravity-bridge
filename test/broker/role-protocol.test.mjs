import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 规格 §9.1 / §9.3 的协议层验证：
 *   - 路由依据是 role（planner|reviewer），phase 降级为被忽略的别名
 *   - /reply 只是「本轮结束」信号：content 可选、verdict 不猜、handledIn 透传
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROKER = path.resolve(HERE, '..', '..', 'broker', 'broker.mjs');
const LISTEN_CLI = path.resolve(HERE, '..', '..', 'broker', 'wait-next-request.mjs');

const RELAY_TIMEOUT_MS = 30_000;

function freePort() {
  return 21000 + Math.floor(Math.random() * 2000);
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-role-'));
  const dataDir = path.join(home, '.dsh', 'agy-collab');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'state.json'),
    JSON.stringify({ enabled: true, sessions: { 's-role': true }, updatedAt: Date.now() }),
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
    if (res.status === 200) return { port, child, home, dataDir };
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill();
  throw new Error('broker did not become healthy in time');
}

function stopBroker(handle) {
  try { handle.child.kill(); } catch { /* ignore */ }
  try { fs.rmSync(handle.home, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** 发一个 /relay，拿到 A 侧看到的 record（通过 /listen 取），然后把它 reply 掉，避免留下悬挂请求。 */
async function relayAndPeek(port, payload) {
  const relay = post(port, '/relay', {
    sessionId: 's-role',
    timeoutMs: RELAY_TIMEOUT_MS,
    ...payload,
  }, RELAY_TIMEOUT_MS + 5000);

  // /listen 会阻塞到有请求为止
  const listenRes = await get(port, '/listen?timeout=8000', 12000);
  const body = JSON.parse(listenRes.body);
  const record = body.request || (Array.isArray(body.requests) ? body.requests[0] : null);
  assert.ok(record, '/listen 应拿到刚发的请求');

  const reply = await post(port, '/reply', { requestId: record.requestId }, 8000).promise;
  const relayRes = await relay.promise;
  return { record, reply, relayRes };
}

// ---------------------------------------------------------------- role 路由

test('role=reviewer 直接决定路由，且带出 round / stage / cold', async () => {
  const h = await startBroker();
  try {
    const { record } = await relayAndPeek(h.port, {
      role: 'reviewer',
      round: 2,
      stage: 'final-review',
      cold: true,
      roleBinding: 'dual',
      task: 'review probe',
      workspace: '/tmp/ws',
    });
    assert.equal(record.role, 'reviewer');
    assert.equal(record.phase, 'review');
    assert.equal(record.legacyPhase, false);
    assert.equal(record.round, 2);
    assert.equal(record.stage, 'final-review');
    assert.equal(record.cold, true);
    assert.equal(record.roleBinding, 'dual');
  } finally {
    stopBroker(h);
  }
});

test('role=planner 时 phase 归一为 plan，estimateSubagents 透传', async () => {
  const h = await startBroker();
  try {
    const { record } = await relayAndPeek(h.port, {
      role: 'planner',
      estimateSubagents: true,
      task: 'plan probe',
    });
    assert.equal(record.role, 'planner');
    assert.equal(record.phase, 'plan');
    assert.equal(record.estimateSubagents, true);
    assert.equal(record.round, 1, '未传 round 时归一为 1');
    assert.equal(record.cold, false);
  } finally {
    stopBroker(h);
  }
});

test('旧 phase=review 无 role 时推断为 reviewer 并标记 legacyPhase', async () => {
  const h = await startBroker();
  try {
    const { record } = await relayAndPeek(h.port, { phase: 'review', task: 'legacy probe' });
    assert.equal(record.role, 'reviewer');
    assert.equal(record.legacyPhase, true);
  } finally {
    stopBroker(h);
  }
});

test('旧 phase=consult 已删除：映射到 planner 而非独立阶段', async () => {
  const h = await startBroker();
  try {
    const { record } = await relayAndPeek(h.port, { phase: 'consult', task: 'consult probe' });
    assert.equal(record.role, 'planner');
    assert.equal(record.legacyPhase, true);
    assert.notEqual(record.phase, 'consult');
  } finally {
    stopBroker(h);
  }
});

test('非法 role 值回落为按 phase 推断，不报错', async () => {
  const h = await startBroker();
  try {
    const { record } = await relayAndPeek(h.port, { role: 'executor', phase: 'review', task: 'bad role' });
    assert.equal(record.role, 'reviewer');
    assert.equal(record.legacyPhase, true);
  } finally {
    stopBroker(h);
  }
});

// ---------------------------------------------------------------- /reply 语义

test('/reply 不带 content 也成功（回执不再是结论载体）', async () => {
  const h = await startBroker();
  try {
    const { reply } = await relayAndPeek(h.port, { role: 'planner', task: 'receipt probe' });
    assert.equal(reply.status, 200);
    const body = JSON.parse(reply.body);
    assert.equal(body.ok, true);
    assert.equal(body.delivered, true);
  } finally {
    stopBroker(h);
  }
});

test('/reply 不再按 phase 编造 verdict（planner 也不会自动得到 PLAN_READY）', async () => {
  const h = await startBroker();
  try {
    const { reply } = await relayAndPeek(h.port, { role: 'planner', task: 'no fake verdict' });
    const body = JSON.parse(reply.body);
    assert.equal(body.verdict, null);
  } finally {
    stopBroker(h);
  }
});

test('/reply 透传 handledIn 与 verdict，不做词表校验也不改写成旧词', async () => {
  const h = await startBroker();
  try {
    const relay = post(h.port, '/relay', {
      sessionId: 's-role', role: 'reviewer', round: 2, cold: true,
      task: 'handledIn probe', timeoutMs: RELAY_TIMEOUT_MS,
    }, RELAY_TIMEOUT_MS + 5000);
    const listenRes = await get(h.port, '/listen?timeout=8000', 12000);
    const record = JSON.parse(listenRes.body).request;

    const replyRes = await post(h.port, '/reply', {
      requestId: record.requestId,
      verdict: 'needs_revision',
      handledIn: 'subagent',
      content: '写了 04/review-r2.md',
    }, 8000).promise;
    const replyBody = JSON.parse(replyRes.body);
    assert.equal(replyBody.verdict, 'needs_revision');
    assert.equal(replyBody.handledIn, 'subagent');
    assert.equal(replyBody.role, 'reviewer');

    const relayRes = await relay.promise;
    const relayBody = JSON.parse(relayRes.body);
    assert.equal(relayBody.ok, true);
    assert.equal(relayBody.verdict, 'needs_revision');
    assert.equal(relayBody.handledIn, 'subagent');
    assert.equal(relayBody.round, 2);
  } finally {
    stopBroker(h);
  }
});

// ---------------------------------------------------------------- A 侧 CLI 输出

function runListenCli(handle, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LISTEN_CLI], {
      env: {
        ...process.env,
        USERPROFILE: handle.home,
        HOME: handle.home,
        DSH_AGY_COLLAB_PORT: String(handle.port),
      },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ out, err, timedOut: true });
    }, timeoutMs);
    child.on('exit', () => { clearTimeout(timer); resolve({ out, err, timedOut: false }); });
  });
}

test('wait-next-request 输出 Role / Round / 模板路径，且不再出现 v1 词表', async () => {
  const h = await startBroker();
  try {
    const relay = post(h.port, '/relay', {
      sessionId: 's-role',
      role: 'reviewer',
      round: 2,
      stage: 'review',
      cold: true,
      roleBinding: 'dual',
      task: 'CLI output probe',
      workspace: 'C:/ws/t-2026-1128-01',
      timeoutMs: RELAY_TIMEOUT_MS,
    }, RELAY_TIMEOUT_MS + 5000);

    const cli = await runListenCli(h);
    assert.equal(cli.timedOut, false, 'CLI 应在拿到请求后退出');
    assert.match(cli.out, /Role\s+:\s*reviewer/, 'CLI 必须打出 Role 而不是 Phase');
    assert.match(cli.out, /Round\s+:\s*2/);
    assert.match(cli.out, /Cold\s+:\s*true/);
    assert.match(cli.out, /rules\/dsh-collab\/reviewer\.md/, '按 role 选载模板');
    assert.match(cli.out, /--handled-in subagent/, 'cold 调用要提示声明 handled-in');
    assert.equal(/PLAN_READY|CONSULT_ANSWERED|APPROVED|CHANGES_REQUESTED/.test(cli.out), false, 'CLI 不该再出现 v1 词表');
    assert.equal(/--verdict/.test(cli.out), false, '回执不再需要 verdict');

    relay.abort();
  } finally {
    stopBroker(h);
  }
});

test('wait-next-request 对 planner 载 planner.md 且提示预估子 agent', async () => {
  const h = await startBroker();
  try {
    const relay = post(h.port, '/relay', {
      sessionId: 's-role',
      role: 'planner',
      estimateSubagents: true,
      task: 'planner CLI probe',
      timeoutMs: RELAY_TIMEOUT_MS,
    }, RELAY_TIMEOUT_MS + 5000);

    const cli = await runListenCli(h);
    assert.match(cli.out, /Role\s+:\s*planner/);
    assert.match(cli.out, /rules\/dsh-collab\/planner\.md/);
    assert.match(cli.out, /subagent_count/);
    relay.abort();
  } finally {
    stopBroker(h);
  }
});
