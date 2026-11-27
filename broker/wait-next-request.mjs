/**
 * Silent background listener for Agent A (Antigravity).
 * Waits until DeepSeek Harness (D) relays a task (`plan`) or execution result (`review`)
 * over the local network broker (127.0.0.1:18765), then prints [DSH_BACKEND_RELAY] and exits 0
 * so Antigravity is automatically woken up to process the request.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROKER_SCRIPT = path.join(__dirname, 'broker.mjs');
const REPLY_SCRIPT_DISPLAY = path.join(__dirname, 'reply-request.mjs').replace(/\\/g, '/');
const HOST = process.env.DSH_AGY_COLLAB_HOST || '127.0.0.1';
const PORT = Number(process.env.DSH_AGY_COLLAB_PORT || 18765);

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

function phaseDesc(phase, compact = false) {
  if (phase === 'plan') {
    return compact ? '阶段一：开局整体任务规划' : '阶段一：请仅进行开局整体任务规划并提交方案';
  }
  if (phase === 'consult') {
    return compact ? '执行中协商：解答疑问或确认不确定选择' : '执行中协商：请就 D 在执行过程中提出的疑问/不确定选择给出明确决策建议';
  }
  return compact ? '阶段二：执行结果审核' : '阶段二：请审核 D 的执行结果、可行性及是否需要修改';
}

function defaultVerdictHint(phase) {
  if (phase === 'plan') return 'PLAN_READY';
  if (phase === 'consult') return 'CONSULT_ANSWERED';
  return 'APPROVED 或 CHANGES_REQUESTED';
}

function printSingleRequest(r) {
  console.log('================================================================');
  console.log('[DSH_BACKEND_RELAY] 收到来自 DeepSeek Harness (D) 的后台协作请求');
  console.log('================================================================');
  const ageSec = Math.max(0, Math.round((Date.now() - (Number(r.createdAt) || Date.now())) / 1000));
  console.log(`Request ID : ${r.requestId}`);
  console.log(`Session ID : ${r.sessionId || '(default)'}`);
  console.log(`Age        : ${ageSec}s (实时任务)`);
  console.log(`Phase      : ${r.phase} (${phaseDesc(r.phase, false)})`);
  console.log(`Workspace  : ${r.workspace || '(未指定)'}`);
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
  console.log('请按角色规则生成规划方案、协商决策或审核结论，并执行以下命令回传给 D：');
  console.log(`node "${REPLY_SCRIPT_DISPLAY}" --id "${r.requestId}" --verdict "${defaultVerdictHint(r.phase)}" --content "<你的回复内容>"`);
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
    console.log(`Phase      : ${r.phase} (${phaseDesc(r.phase, true)})`);
    console.log(`Workspace  : ${r.workspace || '(未指定)'}`);
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
    console.log(`node "${REPLY_SCRIPT_DISPLAY}" --id "${r.requestId}" --verdict "${defaultVerdictHint(r.phase)}" --content "<针对 ${r.requestId} 的回复内容>"`);
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
