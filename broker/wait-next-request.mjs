/**
 * Silent background listener for Agent A (Antigravity).
 * Waits until DeepSeek Harness (D) relays a task (`plan`) or execution result (`review`)
 * over the local network broker (127.0.0.1:18765), then prints [DSH_BACKEND_RELAY] and exits 0
 * so Antigravity is automatically woken up to process the request.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROKER_SCRIPT = path.join(__dirname, 'broker.mjs');
const REPLY_SCRIPT_DISPLAY = path.join(__dirname, 'reply-request.mjs').replace(/\\/g, '/');
const HOST = process.env.DSH_AGY_COLLAB_HOST || '127.0.0.1';
const DATA_DIR = path.join(os.homedir(), '.dsh', 'agy-collab');

/**
 * 端口优先级（规格 §10.6）：env DSH_AGY_COLLAB_PORT > state.json 的 brokerPort > 18765。
 * 两个 CLI 助手也要认这条优先级，否则用户在设置页改了端口，A 侧还在敲 18765。
 */
function resolvePort() {
  const fromEnv = Number(process.env.DSH_AGY_COLLAB_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8'));
    const fromConfig = Number(raw?.brokerPort);
    if (Number.isInteger(fromConfig) && fromConfig > 0 && fromConfig < 65536) return fromConfig;
  } catch {
    // 配置文件不存在或坏了：退回默认端口，不要因此起不来。
  }
  return 18765;
}

const PORT = resolvePort();

function ensureBrokerRunning() {
  return new Promise((resolve) => {
    const req = http.get(`http://${HOST}:${PORT}/health`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => {
      try {
        const child = spawn(process.execPath, [BROKER_SCRIPT], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
      } catch {
        // ignore
      }
      setTimeout(() => resolve(true), 600);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function pollOnce(timeoutMs = 240_000) {
  return new Promise((resolve) => {
    const req = http.get(
      `http://${HOST}:${PORT}/listen?timeout=${timeoutMs}`,
      { timeout: timeoutMs + 10_000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            resolve(data);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * 角色说明（规格 §9.1 / §11.2）：路由依据是 role，不是 phase。
 * 同一个 actor 在 dual 模式下可能同时占规划与审核两槽，所以每次唤醒都靠 role 字段
 * 决定该载哪份模板 —— 模式切换因此是零文件变更。
 */
function roleDesc(role, compact = false) {
  if (role === 'reviewer') {
    return compact
      ? '审核者：只判需求达成与否'
      : '审核者：先读 03-任务清单/tasks.md 理解需求，再读仓库客观产物判定；不读 02 执行方案，不看执行者自述';
  }
  return compact
    ? '规划者：拆解需求、出方案与任务清单'
    : '规划者：读 01-原始任务需求和目的/request.md，写 02-执行方案/plan.md 与 03-任务清单/tasks.md；返工轮读 04 的 findings 写 05';
}

/** 模板文件按 role 选载（§11.2）。dual 模式下两槽同 actor 也只载当前这一份。 */
function templateOf(role) {
  return role === 'reviewer' ? 'reviewer.md' : 'planner.md';
}

function stageDesc(stage) {
  if (stage === 'final-review') return '终审：这一轮的结论要写 06-最终审核/final.md';
  if (stage === 'review') return '常规审核：结论写 04-审核结果/review-r{N}.md';
  if (stage === 'revision') return '返工：针对 04 里的 findings 出修改方案';
  return '首轮规划';
}

function printSingleRequest(r) {
  console.log('================================================================');
  console.log('[DSH_BACKEND_RELAY] 收到来自 DeepSeek Harness (D) 的后台协作请求');
  console.log('================================================================');
  const ageSec = Math.max(0, Math.round((Date.now() - (Number(r.createdAt) || Date.now())) / 1000));
  console.log(`Request ID : ${r.requestId}`);
  console.log(`Session ID : ${r.sessionId || '(default)'}`);
  console.log(`Age        : ${ageSec}s (实时任务)`);
  console.log(`Role       : ${r.role || '(未指定)'} (${roleDesc(r.role, false)})`);
  console.log(`Round      : ${r.round ?? 1}`);
  if (r.stage) console.log(`Stage      : ${r.stage} (${stageDesc(r.stage)})`);
  if (r.roleBinding) console.log(`Role Binding: ${r.roleBinding}`);
  if (r.cold === true) {
    console.log('Cold       : true —— 本次必须当作从没参与过这个任务，只以工作台文件为准');
  }
  if (r.estimateSubagents === true) {
    console.log('Estimate   : 需要预估主 agent 应生成多少个子 agent（填进 plan.md 的 subagent_count）');
  }
  if (r.legacyPhase === true) {
    console.log('Note       : 本次请求未带 role 字段，按旧 phase 推断；升级后请改传 role');
  }
  console.log(`Workspace  : ${r.workspace || '(未指定)'}`);
  console.log('----------------------------------------------------------------');
  console.log(`【模板】按 Role 载 rules/dsh-collab/${templateOf(r.role)}；其余信息一律从 Workspace 文件读，不靠记忆`);
  console.log('----------------------------------------------------------------');
  console.log('【D 转达的任务描述 (Task)】:');
  console.log(r.task || '(无)');
  if (r.context) {
    console.log('----------------------------------------------------------------');
    console.log('【补充上下文 / 规划依据 (Context)】:');
    console.log(r.context);
  }
  if (r.executionReport) {
    console.log('----------------------------------------------------------------');
    console.log('【D 的执行结果报告 (Execution Report)】:');
    console.log(r.executionReport);
  }
  console.log('================================================================');
  console.log('产物先写进 Workspace 对应文件，再回传「本轮结束」信号（回传内容不是结论）：');
  const handledHint = r.cold === true ? ' --handled-in subagent' : '';
  console.log(`node "${REPLY_SCRIPT_DISPLAY}" --id "${r.requestId}"${handledHint} --content "<一句话说明本轮写了哪些文件>"`);
}

function printBatchRequests(batch) {
  console.log('================================================================');
  console.log(`[DSH_BACKEND_RELAY_BATCH] 收到 ${batch.length} 个来自 DeepSeek Harness (D) 的并发后台协作请求`);
  console.log('================================================================');
  console.log(`并发数量   : ${batch.length}`);
  console.log('并行指引   :');
  console.log('  1. 请立即在后台重新启动 wait-next-request.mjs（当前批次已标记为已派发，重挂监听不会重复触发本批次）；');
  console.log(`  2. 请并发处理以下全部 ${batch.length} 个请求（可通过 invoke_subagent 启动多个 self Subagent 并行，或在同一轮并发调用只读工具与 reply-request.mjs），分别为每个 Request ID 独立回传结果。`);
  console.log('  3. 仅需回复当前实时等待的任务；若发现同一 Session ID 存在旧请求或混入已过期的积压/探活请求，直接跳过旧请求不予回复。');
  for (let i = 0; i < batch.length; i++) {
    const r = batch[i];
    const ageSec = Math.max(0, Math.round((Date.now() - (Number(r.createdAt) || Date.now())) / 1000));
    console.log('');
    console.log(`-------------------- [${i + 1}/${batch.length}] Request ID: ${r.requestId} --------------------`);
    console.log(`Session ID : ${r.sessionId || '(default)'}`);
    console.log(`Age        : ${ageSec}s (实时任务)`);
    console.log(`Role       : ${r.role || '(未指定)'} (${roleDesc(r.role, true)})`);
    console.log(`Round      : ${r.round ?? 1}${r.stage ? ` · Stage ${r.stage}` : ''}${r.cold === true ? ' · Cold' : ''}`);
    console.log(`Workspace  : ${r.workspace || '(未指定)'}`);
    console.log(`【模板】rules/dsh-collab/${templateOf(r.role)}（每个请求按自己的 Role 载对应模板）`);
    console.log('【Task】:');
    console.log(r.task || '(无)');
    if (r.context) {
      console.log('【Context】:');
      console.log(r.context);
    }
    if (r.executionReport) {
      console.log('【Execution Report】:');
      console.log(r.executionReport);
    }
    console.log('【独立回传命令】:');
    const handledHint = r.cold === true ? ' --handled-in subagent' : '';
    console.log(`node "${REPLY_SCRIPT_DISPLAY}" --id "${r.requestId}"${handledHint} --content "<针对 ${r.requestId} 的产物清单>"`);
  }
  console.log('================================================================');
}

async function main() {
  await ensureBrokerRunning();
  while (true) {
    const res = await pollOnce(240_000);
    const batch = res && res.ok && res.hasRequest
      ? (Array.isArray(res.requests) && res.requests.length > 0 ? res.requests : (res.request ? [res.request] : []))
      : [];
    if (batch.length === 1) {
      printSingleRequest(batch[0]);
      process.exit(0);
    } else if (batch.length > 1) {
      printBatchRequests(batch);
      process.exit(0);
    }
    // If timed out with no request, ensure broker is alive and continue waiting silently
    await ensureBrokerRunning();
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main();
