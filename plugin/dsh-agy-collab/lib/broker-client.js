/**
 * dsh-agy-collab — broker 端口归属与 attach 判定（规格 §10.2 / §10.4）
 *
 * 把「端口上跑的是不是我们这份 broker」这件事从 lib/index.js 里抽出来，
 * 变成可离线测试的纯模块。三个导出：
 *
 *   probeHealth()      读 /health 并按自家签名判定归属
 *   ensureBroker()     四步判定：attach 复用 / 异己报错 / spawn 后重新探活
 *   readPidRecord()    读 broker.pid 的 JSON 归属记录（含残留清理）
 *
 * 设计要点：
 *   - spawn 之后**必须重新探一次 /health**。早先 lib/index.js:146-176 的做法是
 *     spawn 后 setTimeout(400) 直接 resolve(true)，无论成没成都报成功 —— 这是
 *     规格 §10.2 明确点名的现成 bug。
 *   - 异己占用**不重试、不静默回落**。静默回落会悄悄换掉审核者，用户以为还是
 *     外部 A 在审，实际是本地另一个实例（§10.3）。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** broker 在 /health 里回的自家签名（与 broker/broker.mjs 的 SERVICE_NAME 同值）。 */
export const BROKER_SERVICE_NAME = 'dsh-agy-collab-broker';

/** broker.pid 的 schema 版本（§10.4）。 */
export const PID_SCHEMA_VERSION = 1;

export const DEFAULT_BROKER_PORT = 18765;

/** 四步判定里各步的等待上限。 */
export const HEALTH_TIMEOUT_MS = 1000;
export const SPAWN_CONFIRM_TIMEOUT_MS = 5000;
export const SPAWN_CONFIRM_POLL_MS = 150;

/** ensureBroker 的结局分类，供调用方决定文案与是否拒启。 */
export const BROKER_STATE = Object.freeze({
  /** 自家实例在线，直接复用。 */
  attached: 'attached',
  /** 本进程刚 spawn 出来并已确认起来。 */
  spawned: 'spawned',
  /** 端口通但不是我们的服务。 */
  foreign: 'foreign',
  /** 连不上且 spawn 后也没起来。 */
  unreachable: 'unreachable',
  /** 找不到 broker 脚本，无法 spawn。 */
  missing_script: 'missing_script',
});

/** 端口被异己占用时上抛的文案（§10.2 第 3 步）。 */
export function foreignPortMessage(port) {
  return `端口 ${port} 被其他程序占用，请在设置页改端口或关闭占用它的程序`;
}

/**
 * 发一个 GET 请求并尝试 JSON 解析。失败（连不上 / 超时 / 非 JSON）一律返回 null。
 * @returns {Promise<{ statusCode: number, body: any }|null>}
 */
export function httpGetJson(host, port, urlPath, timeoutMs = HEALTH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let req;
    try {
      req = http.get({ hostname: host, port, path: urlPath, timeout: timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const statusCode = Number(res.statusCode) || 0;
          try {
            done({ statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch {
            done({ statusCode, body: null });
          }
        });
      });
    } catch {
      done(null);
      return;
    }
    req.on('error', () => done(null));
    req.on('timeout', () => {
      try {
        req.destroy();
      } catch {
        // ignore
      }
      done(null);
    });
  });
}

/**
 * 探一次 /health 并判定归属。
 *
 * 四种结局：
 *   - ok         端口通、签名对（service === BROKER_SERVICE_NAME 且 ok === true）
 *   - foreign    端口通、签名不对
 *   - offline    连不上（ECONNREFUSED / 超时）
 *   - unknown    端口通但响应不是 JSON（也是异己，只是说不清是什么）
 *
 * @returns {Promise<{ kind: 'ok'|'foreign'|'offline', statusCode: number, body: any }>}
 */
export async function probeHealth({ host = '127.0.0.1', port = DEFAULT_BROKER_PORT, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  const res = await httpGetJson(host, port, '/health', timeoutMs);
  if (!res) return { kind: 'offline', statusCode: 0, body: null };
  const body = res.body;
  const signed = body && body.ok === true && body.service === BROKER_SERVICE_NAME;
  if (signed) return { kind: 'ok', statusCode: res.statusCode, body };
  return { kind: 'foreign', statusCode: res.statusCode, body };
}

/** broker.pid 的绝对路径。 */
export function pidFileOf(dataDir) {
  return path.join(dataDir, 'broker.pid');
}

/**
 * 读 broker.pid 的 JSON 归属记录，并按 §10.4 的三个用途做一次判定。
 *
 * 判定结果：
 *   - absent     文件不存在
 *   - legacy     v1 写的纯文本 pid（升级后第一次运行会遇到），视为无归属信息
 *   - stale      pid 已不存在，或 bootId 与本次开机不符 → 上次开机遗留，可删
 *   - alive      归属记录指向的进程还活着且属于本次开机
 *
 * @returns {{ kind: 'absent'|'legacy'|'stale'|'alive', record: object|null, reason?: string }}
 */
export function readPidRecord(dataDir, { bootId = null, pidAlive = isPidAlive } = {}) {
  const file = pidFileOf(dataDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').trim();
  } catch {
    return { kind: 'absent', record: null };
  }
  if (!raw) return { kind: 'absent', record: null };

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // v1 写的是纯文本 pid，JSON.parse 会失败（或解析成数字）→ 认成 legacy。
    return { kind: 'legacy', record: null, reason: 'v1 纯文本 pid 文件' };
  }
  if (parsed.service !== BROKER_SERVICE_NAME) {
    return { kind: 'legacy', record: parsed, reason: `归属记录里的 service 不是 ${BROKER_SERVICE_NAME}` };
  }
  const pid = Number(parsed.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { kind: 'stale', record: parsed, reason: '归属记录里的 pid 非法' };
  }
  if (bootId && parsed.bootId && String(parsed.bootId) !== String(bootId)) {
    return { kind: 'stale', record: parsed, reason: 'bootId 与本次开机不符（上次开机遗留）' };
  }
  if (!pidAlive(pid)) {
    return { kind: 'stale', record: parsed, reason: 'pid 已不存在' };
  }
  return { kind: 'alive', record: parsed };
}

/** pid 是否存活。EPERM 说明进程存在但没权限发信号，算存活。 */
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** 删掉残留的 broker.pid（只在判定为 stale / legacy 时调用）。 */
export function clearPidRecord(dataDir) {
  try {
    fs.unlinkSync(pidFileOf(dataDir));
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 端口归属四步判定（§10.2）：
 *   1. GET /health（1000ms）
 *   2. 自家签名 → attach 复用，不 spawn
 *   3. 端口通但签名不符 → 异己占用，返回 foreign，不重试
 *   4. 连不上 → spawn，**重新探 /health 确认真起来了**再返回 spawned
 *
 * @returns {Promise<{ state: string, port: number, health: object|null, message?: string, pid?: number }>}
 */
export async function ensureBroker({
  host = '127.0.0.1',
  port = DEFAULT_BROKER_PORT,
  scriptPath,
  dataDir = path.join(os.homedir(), '.dsh', 'agy-collab'),
  log = () => {},
  spawnImpl = spawn,
  probe = probeHealth,
  confirmTimeoutMs = SPAWN_CONFIRM_TIMEOUT_MS,
  confirmPollMs = SPAWN_CONFIRM_POLL_MS,
  env = process.env,
} = {}) {
  const first = await probe({ host, port });
  if (first.kind === 'ok') {
    return { state: BROKER_STATE.attached, port, health: first.body, pid: Number(first.body?.pid) || undefined };
  }
  if (first.kind === 'foreign') {
    return {
      state: BROKER_STATE.foreign,
      port,
      health: first.body,
      message: foreignPortMessage(port),
    };
  }

  // offline：可能只是正在启动（上一次 spawn 还没 listen 完），先看一眼归属记录。
  // 记录说「本次开机、pid 还活着」→ 再等一小会重探，不重复 spawn（§10.4 复用判据）。
  const bootId = readBootIdSafe();
  const record = readPidRecord(dataDir, { bootId });
  if (record.kind === 'alive') {
    const deadline = Date.now() + confirmTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(confirmPollMs);
      const again = await probe({ host, port });
      if (again.kind === 'ok') {
        return { state: BROKER_STATE.attached, port, health: again.body, pid: Number(again.body?.pid) || undefined };
      }
      if (again.kind === 'foreign') {
        return { state: BROKER_STATE.foreign, port, health: again.body, message: foreignPortMessage(port) };
      }
    }
    // 记录说活着但端口始终不通：不重复 spawn，直接判不可达，让上层决定拒启。
    return { state: BROKER_STATE.unreachable, port, health: null, message: `broker.pid 指向的进程 ${record.record?.pid} 在跑但端口 ${port} 不通` };
  }
  if (record.kind === 'stale' || record.kind === 'legacy') {
    clearPidRecord(dataDir);
    log(`[broker] 清理残留归属记录：${record.reason ?? record.kind}`);
  }

  if (!scriptPath || !fs.existsSync(scriptPath)) {
    return {
      state: BROKER_STATE.missing_script,
      port,
      health: null,
      message: `找不到 broker 脚本：${scriptPath ?? '(未指定)'}`,
    };
  }

  let childPid;
  try {
    const child = spawnImpl(process.execPath, [scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      // 端口要显式传下去：broker 只认 env，不能靠继承宿主那份（用户可能改了配置端口）。
      env: { ...env, DSH_AGY_COLLAB_PORT: String(port) },
    });
    childPid = child?.pid;
    child.unref?.();
  } catch (error) {
    return {
      state: BROKER_STATE.unreachable,
      port,
      health: null,
      message: `spawn broker 失败：${error?.message ?? error}`,
    };
  }

  // 第 4 步的关键：spawn 之后必须真的探到自家签名才算成功。
  const deadline = Date.now() + confirmTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(confirmPollMs);
    const again = await probe({ host, port });
    if (again.kind === 'ok') {
      return { state: BROKER_STATE.spawned, port, health: again.body, pid: Number(again.body?.pid) || childPid };
    }
    if (again.kind === 'foreign') {
      return { state: BROKER_STATE.foreign, port, health: again.body, message: foreignPortMessage(port) };
    }
  }
  return {
    state: BROKER_STATE.unreachable,
    port,
    health: null,
    pid: childPid,
    message: `已 spawn broker（pid=${childPid ?? '?'}），但 ${Math.round(confirmTimeoutMs / 1000)}s 内 /health 未就绪`,
  };
}

/** 读本次开机的 boot-id，失败返回 null（判定退化成只看 pid 是否存活）。 */
export function readBootIdSafe() {
  try {
    const bootMs = Date.now() - os.uptime() * 1000;
    const minute = Math.round(bootMs / 60000);
    // 与 v2/config.js 的 resolveBootId 同算法：开机分钟数的 sha256 前 6 位。
    return createHash('sha256').update(String(minute)).digest('hex').slice(0, 6);
  } catch {
    return null;
  }
}
