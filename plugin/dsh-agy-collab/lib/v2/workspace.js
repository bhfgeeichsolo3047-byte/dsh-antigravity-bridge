/**
 * dsh-agy-collab v2 — 临时工作台（Workspace）
 *
 * 一次任务一个目录，随 Host 启动创建、随 Host 退出删除。规格 §3.2 / §3.3 / §4.1。
 *
 * 层级：
 *   <root>/<host-pid>-<boot-id>/<session-id>/<task-id>/{01..06} + state.json
 *
 * 每一级都带身份，多个会话并发天然不互踩，不需要锁。
 * 零外部依赖；git 调用与 pid 存活判定都可注入，便于离线测试。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

/** 六个子目录（顺序即创建顺序，编号不可改）。 */
export const WORKSPACE_DIRS = Object.freeze({
  request: '01-原始任务需求和目的',
  plan: '02-执行方案',
  tasks: '03-任务清单',
  review: '04-审核结果',
  revision: '05-修改方案',
  final: '06-最终审核',
});

/** 六个 slot 对应的目录名，按编号排序。 */
export const SLOT_ORDER = Object.freeze(['request', 'plan', 'tasks', 'review', 'revision', 'final']);

/** 任务 state.json 的文件名（与配置 state.json 同名但不同目录，见规格 §1.1）。 */
export const TASK_STATE_FILE = 'state.json';

/** 固定文件名（review / revision 带轮次后缀，单独拼）。 */
export const FIXED_FILES = Object.freeze({
  request: 'request.md',
  plan: 'plan.md',
  tasks: 'tasks.md',
  final: 'final.md',
});

/** 带轮次的文件名。 */
export function roundFileName(slot, round) {
  const n = Number(round);
  if (!Number.isInteger(n) || n < 1) throw new Error(`round 必须是 >=1 的整数，收到 ${round}`);
  if (slot === 'review') return `review-r${n}.md`;
  if (slot === 'revision') return `revision-r${n}.md`;
  throw new Error(`slot "${slot}" 没有轮次后缀`);
}

/** 某个 slot 在当前阶段的合法文件名清单（§6.7 校验清单第 2 条）。 */
export function allowedFileNames(slot, { round } = {}) {
  if (slot === 'plan') return [FIXED_FILES.plan];
  if (slot === 'tasks') return [FIXED_FILES.tasks];
  if (slot === 'request') return [FIXED_FILES.request];
  if (slot === 'final') return [FIXED_FILES.final];
  if (slot === 'review' || slot === 'revision') return [roundFileName(slot, round)];
  return [];
}

/** 目录名合法性：01-06 里任何一个，或 state.json。 */
export function isWorkspaceDirName(name) {
  return Object.values(WORKSPACE_DIRS).includes(name);
}

function safeSegment(value, label) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error(`${label} 不能为空`);
  if (/[\\/]/.test(raw) || raw === '.' || raw === '..') {
    throw new Error(`${label} 不能包含路径分隔符：${raw}`);
  }
  return raw;
}

/** 拼出一次任务的完整路径集合（不创建）。 */
export function workspacePath({ root, hostPid, bootId, sessionId, taskId }) {
  const hostDir = `${safeSegment(hostPid, 'hostPid')}-${safeSegment(bootId, 'bootId')}`;
  const sessionDir = safeSegment(sessionId, 'sessionId');
  const taskDir = safeSegment(taskId, 'taskId');
  const hostRoot = path.join(root, hostDir);
  const sessionRoot = path.join(hostRoot, sessionDir);
  const taskRoot = path.join(sessionRoot, taskDir);
  const dirs = {};
  for (const slot of SLOT_ORDER) dirs[slot] = path.join(taskRoot, WORKSPACE_DIRS[slot]);
  return {
    root,
    hostDir,
    hostRoot,
    sessionDir,
    sessionRoot,
    taskDir,
    taskRoot,
    dirs,
    stateFile: path.join(taskRoot, TASK_STATE_FILE),
  };
}

/**
 * 创建一次任务的目录树（幂等）。
 * 不写 01/request.md —— 那是 Host 在拿到需求之后才写，本函数只保证骨架存在。
 */
export function createWorkspace(opts) {
  const paths = workspacePath(opts);
  fs.mkdirSync(paths.taskRoot, { recursive: true });
  for (const slot of SLOT_ORDER) fs.mkdirSync(paths.dirs[slot], { recursive: true });
  return paths;
}

/** 某个 slot 下某个文件的绝对路径。 */
export function filePath(paths, slot, fileName) {
  const dir = paths.dirs?.[slot];
  if (!dir) throw new Error(`unknown slot "${slot}"`);
  return path.join(dir, safeSegment(fileName, 'fileName'));
}

/** 进程是否还活着。ESRCH = 不存在；EPERM = 存在但没权限（仍算活着）。 */
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

/** 把 <pid>-<boot-id> 目录名拆开；不合法返回 null。 */
export function parseHostDirName(name) {
  // boot-id 由 resolveBootId 产出 6 位十六进制，但这里放宽到字母数字：
  // 认不出来就会被当成 skipped 永远清扫不到，残骸会一直堆着，比宽松判定更糟。
  const m = /^(\d+)-([0-9A-Za-z]{3,})$/.exec(String(name ?? ''));
  if (!m) return null;
  return { pid: Number(m[1]), bootId: m[2] };
}

/**
 * 下次启动的静默清扫（§3.3）。
 * 判据：pid 已不存在 **或** boot-id 与当前开机不匹配 → 整段删。
 * 两者都命中才算残骸，单看 pid 会把「刚好被复用的 pid」误删。
 * @returns {{ removed: string[], kept: string[], skipped: string[] }}
 */
export function sweepOrphans({ root, bootId, isAlive = isPidAlive, dryRun = false } = {}) {
  const result = { removed: [], kept: [], skipped: [] };
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const parsed = parseHostDirName(entry.name);
    if (!parsed) {
      result.skipped.push(entry.name);
      continue;
    }
    const pidGone = !isAlive(parsed.pid);
    const bootMismatch = String(parsed.bootId) !== String(bootId);
    if (pidGone || bootMismatch) {
      if (!dryRun) {
        try {
          fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
        } catch {
          result.skipped.push(entry.name);
          continue;
        }
      }
      result.removed.push(entry.name);
    } else {
      result.kept.push(entry.name);
    }
  }
  return result;
}

/**
 * Host 退出时删自己那一整棵 <pid>-<boot-id> 树（§3.3 第一行）。
 * 只删自己这一棵，绝不碰同机其他 Host 的目录。
 */
export function removeHostTree({ root, hostPid, bootId } = {}) {
  const name = `${safeSegment(hostPid, 'hostPid')}-${safeSegment(bootId, 'bootId')}`;
  const target = path.join(root, name);
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return { removed: true, path: target };
  } catch (error) {
    return { removed: false, path: target, error: String(error?.message ?? error) };
  }
}

/** 把一个绝对路径转成相对 base 的 POSIX 形式（快照 diff 的可比键）。 */
export function relKey(base, abs) {
  return path.relative(base, abs).split(path.sep).join('/');
}

function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * 取一次 Workspace 全树快照（§6.4 越权判定用）。
 * 结构：{ '<rel/posix>': { mtime, size, sha256 } }
 * 只收普通文件，跳过目录；读不到的文件 sha256 为 null 但仍入表（存在即记录）。
 */
export function snapshotTree(root) {
  const out = {};
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat = null;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      out[relKey(root, abs)] = {
        mtime: Math.round(stat.mtimeMs),
        size: stat.size,
        sha256: sha256File(abs),
      };
    }
  };
  walk(root);
  return out;
}

/**
 * 比对两次快照，给出新增 / 变化 / 删除三组相对路径。
 */
export function diffSnapshot(before = {}, after = {}) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const key of Object.keys(after)) {
    if (!(key in before)) {
      added.push(key);
      continue;
    }
    const a = before[key];
    const b = after[key];
    if (a.sha256 !== b.sha256 || a.size !== b.size) changed.push(key);
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) removed.push(key);
  }
  return { added, changed, removed };
}

/**
 * 越权判定（§6.4）：差集只允许出现「本轮该写的那个文件」。
 * 允许清单里的相对路径要先用 relKey(taskRoot, filePath(...)) 算出来传进来。
 *
 * state.json 是 Host 自己的状态机账本，角色调用的每一次事件推进都会写它，
 * 那是 Host 的写入而不是角色的写入。但它不能被按文件名无条件豁免 ——
 * 否则角色直接篡改 state.json（例如伪造 done）就完全失明。
 * 因此豁免条件收紧成：调用方传入 Host 自己刚落盘的哈希，且快照里 state.json
 * 的 sha256 必须与之相等；哈希不一致（被改写）或被删除都计入 extras。
 *
 * @param {object} before 调用前快照
 * @param {object} after 调用后快照
 * @param {string[]} allowedRel 本轮允许改动的相对路径
 * @param {{ expectedHostStateSha256?: string|null }} [options]
 * @returns {{ ok: boolean, extras: string[] }}
 */
export function assertSnapshotDelta(before, after, allowedRel = [], options = {}) {
  const allowed = new Set(allowedRel.map((v) => String(v).split(path.sep).join('/')));
  const { added, changed, removed } = diffSnapshot(before, after);
  const expected = options?.expectedHostStateSha256 ?? null;
  const extras = [...added, ...changed, ...removed].filter((rel) => {
    if (allowed.has(rel)) return false;
    if (rel !== TASK_STATE_FILE) return true;
    if (!expected) return true;
    const afterSha = after?.[TASK_STATE_FILE]?.sha256 ?? null;
    return afterSha !== expected;
  });
  return { ok: extras.length === 0, extras };
}

/** 取某个文件的 sha256；读不到返回 null。给 Host 记录自己刚落盘的 state.json 哈希用。 */
export function sha256OfFile(file) {
  return sha256File(file);
}

/**
 * git status --porcelain（Reviewer 的客观产物输入之一，§6.2）。
 * 注入 run 便于离线测试；默认用 child_process 同步跑。
 */
export function gitStatusPorcelain(cwd, { run } = {}) {
  const runner = run ?? ((dir) => execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }));
  try {
    return String(runner(cwd) ?? '');
  } catch {
    return '';
  }
}

/** Git 快照里 diff 正文的默认字符预算：超出就截断并注明，避免把整份 diff 塞进提示词。 */
export const REPO_EVIDENCE_MAX_DIFF_CHARS = 6000;

/**
 * 采集仓库的客观 Git 快照，作为 Reviewer 的证据源（规格 §6.2「仓库客观产物」）。
 *
 * 为什么要 Host 侧采：ADR-0001 把角色的隔离面压到「无子进程、无 shell」，Reviewer
 * 自己跑不了 git。但「审核者只看仓库客观产物」不能因此退化成只看六目录里 Planner 写的
 * 文字 —— 那样审核的是别人的叙述，不是代码。所以由 Host（唯一可信的采集方）读一次
 * 只读快照，作为证据附在审核消息里，角色本身仍然零子进程。
 *
 * 非 git 目录、git 不可用、仓库为空都返回空串，绝不抛错（审核不该因为采不到证据而中断）。
 * @param {string} cwd
 * @param {{ runGit?: function, maxDiffChars?: number }} [opts]
 *   runGit(cwd, args) => string：注入执行器便于离线测试
 * @returns {string}
 */
export function collectRepoGitEvidence(cwd, { runGit = null, maxDiffChars = REPO_EVIDENCE_MAX_DIFF_CHARS } = {}) {
  const dir = String(cwd ?? '').trim();
  if (!dir) return '';
  const run = (args) => {
    try {
      if (typeof runGit === 'function') return String(runGit(dir, args) ?? '');
      return String(execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) ?? '');
    } catch {
      return '';
    }
  };

  const status = run(['status', '--porcelain']).trim();
  const stat = run(['diff', '--stat', 'HEAD']).trim();
  const diff = run(['diff', 'HEAD']);
  // 三条全空 = 不是 git 仓库，或仓库干净且没有任何改动可看。
  if (!status && !stat && !diff.trim()) return '';

  const parts = [];
  if (status) parts.push(`--- git status --porcelain ---\n${status}`);
  if (stat) parts.push(`--- git diff --stat HEAD ---\n${stat}`);
  if (diff.trim()) {
    const trimmed = diff.trim();
    parts.push(
      trimmed.length > maxDiffChars
        ? `--- git diff HEAD（已截断到 ${maxDiffChars} 字符，共 ${trimmed.length}）---\n${trimmed.slice(0, maxDiffChars)}`
        : `--- git diff HEAD ---\n${trimmed}`,
    );
  }
  return parts.join('\n\n');
}
