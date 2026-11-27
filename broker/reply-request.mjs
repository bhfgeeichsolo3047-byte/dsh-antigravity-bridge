/**
 * A 侧回传助手：向 DSH 的本地 broker 提交「本轮结束」信号（规格 §9.3）。
 *
 * 语义变化（v2）：
 *   - 回传内容**不再是结论**。真正的结论在 Workspace 的 04/06 文件里，Host 自己去读并校验。
 *   - 因此 --content / --file 变成可选；只发一个「我做完了」也合法。
 *   - --verdict 只做透传，不再有 PLAN_READY / CONSULT_ANSWERED / APPROVED / CHANGES_REQUESTED
 *     这套旧词表；要传就传 pass / needs_revision，但那也只是给人看的，判定以文件为准。
 *   - 新增 --handled-in main|subagent：dual 冷调用下必须声明这次是在主对话还是子实例里处理的。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const HANDLED_IN_VALUES = ['main', 'subagent'];

function parseArgs(argv) {
  const out = { id: '', verdict: '', content: '', file: '', handledIn: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--id' || a === '-i') && argv[i + 1]) {
      out.id = argv[++i];
    } else if ((a === '--verdict' || a === '-v') && argv[i + 1]) {
      out.verdict = argv[++i];
    } else if ((a === '--content' || a === '-c') && argv[i + 1]) {
      out.content = argv[++i];
    } else if ((a === '--file' || a === '-f') && argv[i + 1]) {
      out.file = argv[++i];
    } else if ((a === '--handled-in' || a === '-H') && argv[i + 1]) {
      out.handledIn = argv[++i];
    }
  }
  if (out.file && !out.content) {
    try {
      out.content = fs.readFileSync(out.file, 'utf8');
    } catch (err) {
      console.error(`[agy-collab-reply] 读不到 --file 指定的文件：${out.file} (${err.message})`);
      process.exit(1);
    }
  }
  return out;
}

const args = parseArgs(process.argv);

if (!args.id) {
  console.error('Usage: node reply-request.mjs --id <requestId> [--handled-in main|subagent] [--content "<text>" | --file <path>]');
  process.exit(1);
}
if (args.handledIn && !HANDLED_IN_VALUES.includes(args.handledIn)) {
  console.error(`[agy-collab-reply] --handled-in 只接受 ${HANDLED_IN_VALUES.join(' | ')}，收到：${args.handledIn}`);
  process.exit(1);
}

const body = JSON.stringify({
  requestId: args.id,
  verdict: args.verdict || undefined,
  handledIn: args.handledIn || undefined,
  content: args.content || undefined,
});

const req = http.request(
  {
    hostname: HOST,
    port: PORT,
    path: '/reply',
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    },
    timeout: 10_000,
  },
  (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      console.log(`[agy-collab-reply] status=${res.statusCode} response=${text}`);
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
  },
);

req.on('error', (err) => {
  console.error(`[agy-collab-reply] error: ${err.message}`);
  process.exit(1);
});

req.write(body);
req.end();
