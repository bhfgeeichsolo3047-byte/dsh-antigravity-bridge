/**
 * broker 端口归属与 pid 归属记录（规格 §10.2 / §10.4 / §12.4）。
 *
 * 这里守三条以前没有测试护着的行为：
 *   1. /health 必须带自家签名 service，否则 Host 无法区分「自家 broker」与「别人占着端口」；
 *   2. broker.pid 必须是 JSON 归属记录（v1 写的是纯文本 pid，无法判断是否上次开机遗留）；
 *   3. 端口被异己占用时必须以 exit code 2 退出并打出可诊断的文案 —— 不能静默 exit(0)，
 *      静默退出会让 UI 上「总线在线」永远是个说不清的状态。
 *
 * 全部测试用独立临时 HOME + 随机端口，不触碰真实 ~/.dsh/agy-collab。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  BROKER_SERVICE_NAME,
  BROKER_STATE,
  DEFAULT_BROKER_PORT,
  PID_SCHEMA_VERSION,
  clearPidRecord,
  ensureBroker,
  foreignPortMessage,
  isPidAlive,
  pidFileOf,
  probeHealth,
  readPidRecord,
} from '../../plugin/dsh-agy-collab/lib/broker-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROKER = path.resolve(HERE, '..', '..', 'broker', 'broker.mjs');

function freePort() {
  return 21000 + Math.floor(Math.random() * 2000);
}

function mkDataDir() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-own-'));
  const dataDir = path.join(home, '.dsh', 'agy-collab');
  fs.mkdirSync(dataDir, { recursive: true });
  return { home, dataDir, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function getJson(port, urlPath, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch {
          resolve({ status: res.statusCode, body: null });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function waitHealthy(port, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const res = await getJson(port, '/health', 800);
    if (res?.status === 200) return res.body;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

function spawnBroker({ home, port, stdio = 'ignore' }) {
  return spawn(process.execPath, [BROKER], {
    env: { ...process.env, USERPROFILE: home, HOME: home, DSH_AGY_COLLAB_PORT: String(port) },
    stdio: stdio === 'ignore' ? 'ignore' : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

// ── readPidRecord 四态 ───────────────────────────────────────────────

test('readPidRecord：文件不存在 → absent', () => {
  const d = mkDataDir();
  try {
    assert.equal(readPidRecord(d.dataDir).kind, 'absent');
  } finally {
    d.cleanup();
  }
});

test('readPidRecord：v1 的纯文本 pid → legacy（无法判断归属）', () => {
  const d = mkDataDir();
  try {
    fs.writeFileSync(pidFileOf(d.dataDir), String(process.pid), 'utf8');
    const rec = readPidRecord(d.dataDir);
    assert.equal(rec.kind, 'legacy');
    assert.ok(rec.reason);
  } finally {
    d.cleanup();
  }
});

test('readPidRecord：bootId 与本次开机不符 → stale（上次开机遗留）', () => {
  const d = mkDataDir();
  try {
    fs.writeFileSync(pidFileOf(d.dataDir), JSON.stringify({
      service: BROKER_SERVICE_NAME,
      schemaVersion: PID_SCHEMA_VERSION,
      pid: process.pid,
      port: 18765,
      startedAt: Date.now(),
      bootId: 'aaaaaa',
    }), 'utf8');
    const rec = readPidRecord(d.dataDir, { bootId: 'bbbbbb', pidAlive: () => true });
    assert.equal(rec.kind, 'stale');
    assert.match(rec.reason, /bootId/);
  } finally {
    d.cleanup();
  }
});

test('readPidRecord：pid 已不存在 → stale', () => {
  const d = mkDataDir();
  try {
    fs.writeFileSync(pidFileOf(d.dataDir), JSON.stringify({
      service: BROKER_SERVICE_NAME,
      schemaVersion: PID_SCHEMA_VERSION,
      pid: 999999,
      port: 18765,
      startedAt: Date.now(),
      bootId: 'bbbbbb',
    }), 'utf8');
    const rec = readPidRecord(d.dataDir, { bootId: 'bbbbbb', pidAlive: () => false });
    assert.equal(rec.kind, 'stale');
    assert.match(rec.reason, /pid/);
  } finally {
    d.cleanup();
  }
});

test('readPidRecord：归属记录自洽且进程在 → alive；clearPidRecord 能删掉', () => {
  const d = mkDataDir();
  try {
    fs.writeFileSync(pidFileOf(d.dataDir), JSON.stringify({
      service: BROKER_SERVICE_NAME,
      schemaVersion: PID_SCHEMA_VERSION,
      pid: process.pid,
      port: 18765,
      startedAt: Date.now(),
      bootId: 'bbbbbb',
    }), 'utf8');
    const rec = readPidRecord(d.dataDir, { bootId: 'bbbbbb', pidAlive: () => true });
    assert.equal(rec.kind, 'alive');
    assert.equal(rec.record.pid, process.pid);
    assert.equal(clearPidRecord(d.dataDir), true);
    assert.equal(fs.existsSync(pidFileOf(d.dataDir)), false);
  } finally {
    d.cleanup();
  }
});

test('isPidAlive：本进程算活，明显不存在的 pid 算死', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999999), false);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive('abc'), false);
});

// ── ensureBroker 四步判定（全注入，不真起进程） ──────────────────────

test('ensureBroker：端口上已是自家 broker → attached，不 spawn', async () => {
  let spawned = 0;
  const result = await ensureBroker({
    port: 18765,
    dataDir: mkDataDir().dataDir,
    probe: async () => ({ kind: 'ok', statusCode: 200, body: { ok: true, service: BROKER_SERVICE_NAME, pid: 1234 } }),
    spawnImpl: () => { spawned += 1; return { pid: 1, unref() {} }; },
  });
  assert.equal(result.state, BROKER_STATE.attached);
  assert.equal(result.pid, 1234);
  assert.equal(spawned, 0);
});

test('ensureBroker：端口被异己占用 → foreign + 可操作文案，不 spawn、不重试', async () => {
  let spawned = 0;
  const result = await ensureBroker({
    port: 18766,
    dataDir: mkDataDir().dataDir,
    probe: async () => ({ kind: 'foreign', statusCode: 200, body: { ok: true } }),
    spawnImpl: () => { spawned += 1; return { pid: 1, unref() {} }; },
  });
  assert.equal(result.state, BROKER_STATE.foreign);
  assert.equal(result.message, foreignPortMessage(18766));
  assert.match(result.message, /被其他程序占用/);
  assert.equal(spawned, 0);
});

test('ensureBroker：连不上 → spawn 后必须真的探到自家签名才算成功', async () => {
  const d = mkDataDir();
  try {
    let probes = 0;
    let spawned = 0;
    const result = await ensureBroker({
      port: 18767,
      dataDir: d.dataDir,
      scriptPath: BROKER,
      confirmTimeoutMs: 2000,
      confirmPollMs: 10,
      // 第一次 offline（spawn 前），之后 ok（spawn 起来了）。
      probe: async () => {
        probes += 1;
        return probes === 1
          ? { kind: 'offline', statusCode: 0, body: null }
          : { kind: 'ok', statusCode: 200, body: { ok: true, service: BROKER_SERVICE_NAME, pid: 4321 } };
      },
      spawnImpl: () => { spawned += 1; return { pid: 4321, unref() {} }; },
    });
    assert.equal(result.state, BROKER_STATE.spawned);
    assert.equal(spawned, 1);
    assert.equal(result.pid, 4321);
  } finally {
    d.cleanup();
  }
});

test('ensureBroker：spawn 了但一直探不到 → unreachable（不许谎报成功）', async () => {
  const d = mkDataDir();
  try {
    const result = await ensureBroker({
      port: 18768,
      dataDir: d.dataDir,
      scriptPath: BROKER,
      confirmTimeoutMs: 300,
      confirmPollMs: 20,
      probe: async () => ({ kind: 'offline', statusCode: 0, body: null }),
      spawnImpl: () => ({ pid: 5555, unref() {} }),
    });
    assert.equal(result.state, BROKER_STATE.unreachable);
    assert.match(result.message, /未就绪/);
  } finally {
    d.cleanup();
  }
});

test('ensureBroker：找不到 broker 脚本 → missing_script，不 spawn', async () => {
  let spawned = 0;
  const result = await ensureBroker({
    port: 18769,
    dataDir: mkDataDir().dataDir,
    scriptPath: path.join(os.tmpdir(), 'definitely-not-here', 'broker.mjs'),
    probe: async () => ({ kind: 'offline', statusCode: 0, body: null }),
    spawnImpl: () => { spawned += 1; return { pid: 1, unref() {} }; },
  });
  assert.equal(result.state, BROKER_STATE.missing_script);
  assert.equal(spawned, 0);
});

// ── 真起 broker：/health 签名 + broker.pid JSON ──────────────────────

test('真 broker：/health 带 service 签名，broker.pid 是 JSON 五字段归属记录', async () => {
  const d = mkDataDir();
  const port = freePort();
  const child = spawnBroker({ home: d.home, port });
  try {
    const health = await waitHealthy(port);
    assert.ok(health, 'broker 未在 15s 内就绪');
    assert.equal(health.ok, true);
    assert.equal(health.service, BROKER_SERVICE_NAME);
    assert.equal(health.schemaVersion, PID_SCHEMA_VERSION);
    assert.equal(health.port, port);
    assert.equal(typeof health.bootId, 'string');
    assert.equal(health.bootId.length, 6);

    const pidPath = pidFileOf(d.dataDir);
    assert.equal(fs.existsSync(pidPath), true, 'broker.pid 未写出');
    const record = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
    assert.equal(record.service, BROKER_SERVICE_NAME);
    assert.equal(record.schemaVersion, PID_SCHEMA_VERSION);
    assert.equal(record.pid, child.pid);
    assert.equal(record.port, port);
    assert.equal(typeof record.startedAt, 'number');
    assert.equal(record.bootId, health.bootId);

    // probeHealth 对真 broker 必须判成 ok（Host 侧 attach 的判据）。
    const probed = await probeHealth({ port });
    assert.equal(probed.kind, 'ok');
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    d.cleanup();
  }
});

test('真 broker：端口被异己占用 → exit 2 且 stderr 打出可诊断文案（不再静默 exit 0）', async () => {
  const d = mkDataDir();
  const port = freePort();
  // 占位者：一个对 /health 回 {"ok":true} 但不带 service 的普通 HTTP 服务。
  const occupant = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => occupant.listen(port, '127.0.0.1', resolve));
  try {
    const child = spawnBroker({ home: d.home, port, stdio: 'pipe' });
    const stderrChunks = [];
    child.stderr.on('data', (c) => stderrChunks.push(c));
    const code = await new Promise((resolve) => {
      child.on('exit', (c) => resolve(c));
      setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve('timeout'); }, 10000);
    });
    assert.equal(code, 2);
    const stderr = Buffer.concat(stderrChunks).toString('utf8');
    assert.match(stderr, /被其他程序占用/);
    assert.match(stderr, /设置页改端口/);
    // 异己占用时不该写出归属记录：那个端口不归我们。
    assert.equal(fs.existsSync(pidFileOf(d.dataDir)), false);
  } finally {
    await new Promise((resolve) => occupant.close(resolve));
    d.cleanup();
  }
});

test('真 broker：同一端口第二个实例探到自家签名后正常退出 0', async () => {
  const d = mkDataDir();
  const port = freePort();
  const first = spawnBroker({ home: d.home, port });
  try {
    const health = await waitHealthy(port);
    assert.ok(health);
    const second = spawnBroker({ home: d.home, port, stdio: 'pipe' });
    const code = await new Promise((resolve) => {
      second.on('exit', (c) => resolve(c));
      setTimeout(() => { try { second.kill(); } catch { /* ignore */ } resolve('timeout'); }, 10000);
    });
    assert.equal(code, 0);
    // 第二个实例退出时不能把第一个实例的归属记录删掉。
    assert.equal(fs.existsSync(pidFileOf(d.dataDir)), true);
    const record = JSON.parse(fs.readFileSync(pidFileOf(d.dataDir), 'utf8'));
    assert.equal(record.pid, first.pid);
  } finally {
    try { first.kill(); } catch { /* ignore */ }
    d.cleanup();
  }
});

test('DEFAULT_BROKER_PORT 仍是 18765（兼容旧部署的默认值）', () => {
  assert.equal(DEFAULT_BROKER_PORT, 18765);
});
