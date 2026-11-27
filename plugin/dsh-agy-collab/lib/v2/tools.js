/**
 * dsh-agy-collab v2 — Host 侧工具
 *
 * 规格 §6.7（collab_write 的四条校验）、§6.8（Executor 的三个触发点）、§5.5（关开关语义）。
 *
 * 设计要点：本文件只导出「处理器 + 工具描述」，不 import 宿主包。
 * 真正的 defineTool 由调用方注入，这样离线测试可以拿到裸处理器直接跑。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  allowedFileNames,
  assertSnapshotDelta,
  filePath,
  relKey,
  snapshotTree,
} from './workspace.js';
import { validateArtifact } from './artifacts.js';
import { writableSlots } from './state-machine.js';

export const TOOL_NAMES = Object.freeze({
  write: 'collab_write',
  submit: 'collab_submit_for_review',
  blocked: 'collab_mark_blocked',
  abort: 'collab_abort',
});

/** 工具返回统一形状：ok / 说明 / 可选数据。 */
function ok(message, data) {
  return { ok: true, message, ...(data ? { data } : {}) };
}
function bad(message, data) {
  return { ok: false, message, ...(data ? { data } : {}) };
}

/**
 * collab_write 的四条校验（§6.7）。
 *
 * 依赖注入（全部由调用方给，便于测试）：
 *  - getTask(): 当前任务 state.json 内容
 *  - getRole(): 调用者角色（'planner' | 'reviewer'）
 *  - getRoleBindingMode(): 'triple' | 'dual'
 *  - applyEvent(event, opts): 把状态机事件落到 state.json，返回新 state
 *  - now(): 时间戳
 */
export function createCollabWriteHandler(deps) {
  const {
    getTask,
    getRole,
    getRoleBindingMode = () => 'triple',
    applyEvent = () => ({ ok: true }),
    getReviewerMode = () => 'strict',
    getEstimateSubagents = () => false,
    now = () => Date.now(),
  } = deps ?? {};

  return async function collabWrite(args) {
    const slot = String(args?.slot ?? '').trim();
    const fileName = String(args?.filename ?? '').trim();
    const content = String(args?.content ?? '');

    const task = getTask?.();
    if (!task) return bad('没有正在进行的任务');
    const role = getRole?.();

    // ── 校验 1：slot 必须在该角色当前状态的可写集合里 ──
    const slots = writableSlots(role, task.state, { roleBindingMode: getRoleBindingMode() });
    if (!slots.includes(slot)) {
      const evt = applyEvent('overreach', { note: `${role} 在 ${task.state} 试图写 ${slot}` });
      return bad(
        `角色 ${role} 在状态 ${task.state} 不能写 slot "${slot}"（可写：${slots.join('、') || '无'}）`,
        { overreach: true, state: evt?.state?.state },
      );
    }

    // ── 校验 2：filename 必须在本阶段允许的清单里 ──
    const round = Number(task.round);
    const allowed = allowedFileNames(slot, { round });
    if (!allowed.includes(fileName)) {
      return bad(`文件名 "${fileName}" 不在本阶段允许清单里（允许：${allowed.join('、')}）`, {
        allowed,
      });
    }

    // ── 校验 3：内容必须过 front-matter 与 tasks.md 三条硬检查 ──
    const requirementIds = deps.getRequirementIds?.() ?? [];
    const verdict = validateArtifact({
      slot,
      text: content,
      round,
      mode: getReviewerMode(),
      requirementIds,
      estimateSubagents: getEstimateSubagents(),
    });
    if (!verdict.ok) {
      // tasks.md 违约走 format-violation（不占驳回轮次）；其余算协议违规。
      if (slot === 'tasks') {
        const evt = applyEvent('format-violation', { note: verdict.errors.join('；') });
        return bad(`tasks.md 违约：${verdict.errors.join('；')}`, {
          violations: verdict.errors,
          formatViolation: true,
          state: evt?.state?.state,
        });
      }
      return bad(`产物校验不通过：${verdict.errors.join('；')}`, { violations: verdict.errors });
    }

    // ── 校验 4：写前写后快照 diff，差集必须恰好是这一个文件 ──
    const paths = deps.getPaths?.();
    if (!paths?.taskRoot) return bad('工作台路径未初始化');
    const target = filePath(paths, slot, fileName);
    const allowedRel = [relKey(paths.taskRoot, target)];

    const before = snapshotTree(paths.taskRoot);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    const after = snapshotTree(paths.taskRoot);
    const delta = assertSnapshotDelta(before, after, allowedRel);
    if (!delta.ok) {
      const evt = applyEvent('overreach', { note: `写 ${slot}/${fileName} 时多出：${delta.extras.join('、')}` });
      return bad(`写入时出现了预期外的文件变化：${delta.extras.join('、')}`, {
        overreach: true,
        extras: delta.extras,
        state: evt?.state?.state,
      });
    }

    deps.onWritten?.({
      slot,
      fileName,
      path: target,
      round,
      verdict: verdict.data?.verdict,
      findings: verdict.data?.findings,
      requirementIds: verdict.requirementIds,
      writtenAt: Number(now()) || Date.now(),
    });

    return ok(`已写入 ${slot}/${fileName}`, {
      path: target,
      slot,
      fileName,
      verdict: verdict.data?.verdict ?? null,
    });
  };
}

/** collab_submit_for_review（T5 / T6）：只在 running 可用。 */
export function createSubmitForReviewHandler(deps) {
  const { getTask, applyEvent } = deps ?? {};
  return async function submitForReview(args) {
    const task = getTask?.();
    if (!task) return bad('没有正在进行的任务');
    if (task.state !== 'running') {
      return bad(`collab_submit_for_review 只在 running 状态可用，当前是 ${task.state}`);
    }
    const summary = String(args?.summary ?? '').trim();
    const evt = applyEvent('executor-submit', { note: summary || undefined });
    if (evt && evt.ok === false) return bad(evt.error ?? '状态转移失败');
    return ok('已提交审核', { state: evt?.state?.state ?? null, summary });
  };
}

/** collab_mark_blocked（T7）：只在 running 可用，reason 必填。 */
export function createMarkBlockedHandler(deps) {
  const { getTask, applyEvent } = deps ?? {};
  return async function markBlocked(args) {
    const task = getTask?.();
    if (!task) return bad('没有正在进行的任务');
    if (task.state !== 'running') {
      return bad(`collab_mark_blocked 只在 running 状态可用，当前是 ${task.state}`);
    }
    const reason = String(args?.reason ?? '').trim();
    if (!reason) return bad('reason 必填：要说清为什么做不下去');
    const evt = applyEvent('executor-blocked', { note: reason });
    if (evt && evt.ok === false) return bad(evt.error ?? '状态转移失败');
    return ok('已标记为阻塞，等待用户处理', { state: evt?.state?.state ?? null, reason });
  };
}

/** collab_abort（T14）：任何非终态可用。 */
export function createAbortHandler(deps) {
  const { getTask, applyEvent } = deps ?? {};
  return async function abort(args) {
    const task = getTask?.();
    if (!task) return bad('没有正在进行的任务');
    const evt = applyEvent('abort', { note: String(args?.reason ?? '').trim() || undefined });
    if (evt && evt.ok === false) return bad(evt.error ?? '状态转移失败');
    return ok('任务已中止', { state: evt?.state?.state ?? null });
  };
}

/**
 * 把「JSON Schema 形状」的参数描述转成宿主 defineTool 要的 ParameterSchemaSpec。
 *
 * 宿主契约（dsh-tools/src/schema.ts:104、:291-296）：
 *  - parameters 本身就是「属性映射」，**不能包** { type, properties, required } 外壳；
 *  - 必填用属性上的 `required: true`，不是外层 required 数组；
 *  - 属性值必须是 value schema 对象，且 required 只能是 true。
 * 传错会直接抛 JsonSchemaError: parameters.type must be a value schema object。
 */
export function toParameterSchemaSpec(schema) {
  const src = schema && typeof schema === 'object' ? schema : {};
  const props = src.properties && typeof src.properties === 'object' ? src.properties : {};
  const required = Array.isArray(src.required) ? src.required.map(String) : [];
  const spec = {};
  for (const [key, value] of Object.entries(props)) {
    const node = value && typeof value === 'object' ? { ...value } : { type: 'json' };
    if (required.includes(key)) node.required = true;
    else delete node.required;
    spec[key] = node;
  }
  return spec;
}

/**
 * ParameterSchemaSpec → 裸 JSON Schema（给拿不到宿主时的兼容兜底用，
 * 参照 v1 plugin/dsh-agy-collab/lib/index.js:177-186 的 compileProps）。
 */
export function compileParameterSchemaSpec(spec) {
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(spec && typeof spec === 'object' ? spec : {})) {
    const { required: mark, ...rest } = value && typeof value === 'object' ? value : {};
    if (mark === true) required.push(key);
    properties[key] = rest;
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

/**
 * 工具返回值的 canonical output schema（value schema DSL）。
 * 对象节点必须显式写 additionalProperties；data 用 type:'json' 放开任意 JSON。
 */
export const TOOL_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    message: { type: 'string', required: true },
    data: { type: 'json' },
  },
});

/**
 * 四个工具的 JSON Schema 描述（与宿主 defineTool 解耦，测试与设置页都能读）。
 * 注意：这里的 parameters 是「可读的 JSON Schema 形状」，装配时会经
 * toParameterSchemaSpec 转成宿主契约。
 */
export const TOOL_SPECS = Object.freeze([
  {
    name: TOOL_NAMES.write,
    description:
      '把一份协作产物交给 Host 写入临时工作台。Host 会校验 slot 是否在当前角色的可写集合、文件名是否在本阶段允许清单、内容是否通过 front-matter 校验，通过后才落盘。',
    parameters: {
      type: 'object',
      properties: {
        slot: {
          type: 'string',
          enum: ['plan', 'tasks', 'review', 'revision', 'final'],
          description: '要写的目录：plan=02 执行方案、tasks=03 任务清单、review=04 审核结果、revision=05 修改方案、final=06 最终审核',
        },
        filename: { type: 'string', description: '文件名，例如 plan.md / tasks.md / review-r1.md / revision-r1.md / final.md' },
        content: { type: 'string', description: '完整文件内容，含 front-matter' },
      },
      required: ['slot', 'filename', 'content'],
    },
  },
  {
    name: TOOL_NAMES.submit,
    description: '执行者提交本轮成果、请求审核。只在 running 状态可用。summary 只写进任务状态，不进审核者输入。',
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string', description: '一句话说明这轮做了什么（可选）' } },
      required: [],
    },
  },
  {
    name: TOOL_NAMES.blocked,
    description: '执行者判定任务无法完成（需求不清、外部依赖不可用），标记为阻塞并等待用户处理。只在 running 状态可用。',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: '为什么做不下去（必填）' } },
      required: ['reason'],
    },
  },
  {
    name: TOOL_NAMES.abort,
    description: '中止当前任务。任何非终态可用。',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: '中止原因（可选）' } },
      required: [],
    },
  },
]);

/**
 * 用注入的 defineTool 把处理器包成宿主工具定义。
 * 宿主不可用时调用方可以不调这个函数，直接拿处理器做离线测试。
 */
export function buildToolDefinitions({ defineTool, handlers, extraSpecs = [] }) {
  if (typeof defineTool !== 'function') throw new Error('buildToolDefinitions 需要 defineTool');
  const given = handlers && typeof handlers === 'object' ? handlers : {};
  // 只装配调用方真正给了处理器的工具：不同角色拿到的工具子集不同
  // （Planner/Reviewer 只拿 collab_write + collab_abort，Executor 拿另外三个）。
  // extraSpecs 用于 Host 侧独有的工具（如 collab_start），它们不在角色工具清单里。
  const allSpecs = [...TOOL_SPECS, ...(Array.isArray(extraSpecs) ? extraSpecs : [])];
  const specs = allSpecs.filter((spec) => typeof given[spec.name] === 'function');
  if (specs.length === 0) throw new Error('buildToolDefinitions 至少需要一个处理器');
  return specs.map((spec) => {
    const handler = given[spec.name];
    return defineTool({
      name: spec.name,
      description: spec.description,
      // 宿主 defineTool 要 ParameterSchemaSpec（属性映射），不是 JSON Schema 外壳。
      parameters: toParameterSchemaSpec(spec.parameters),
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        // 契约要求 ContentBlock[]（dsh-tools/src/contracts.ts:21），不是 string。
        render: (_args, value) => [{ type: 'text', text: renderToolResult(value) }],
      },
      execute: async (args, exec) => handler(args, exec),
    });
  });
}

/** 渲染时给 data 块留的字符预算：超过就截断并注明，绝不吐半截 JSON。 */
export const RENDER_DATA_MAX_CHARS = 8000;

/**
 * 工具返回值的统一文本渲染（client.js 与 CLI 都能直接用）。
 *
 * 宿主只把 output.render 的文本喂给模型，`data` 字段（task_root / plan_path /
 * findings / instruction 等）不进模型视野 —— 早先只渲染 message 时，Executor 拿到
 * 「审核驳回，请按下面这段返工」却看不到 instruction，等于把返工指令丢了。
 * 所以有非空 data 时在首行状态后追加一段 JSON；没有 data 时保持原单行输出。
 */
export function renderToolResult(value) {
  if (!value || typeof value !== 'object') return String(value ?? '');
  const head = value.ok ? `✅ ${value.message ?? '完成'}` : `❌ ${value.message ?? '失败'}`;
  const data = value.data;
  if (!data || typeof data !== 'object') return head;
  // 空对象 / 空数组不追加，保持单行（roles-tools.test.mjs 断言过 `/^✅ 好的$/`）。
  if (!Array.isArray(data) && Object.keys(data).length === 0) return head;
  if (Array.isArray(data) && data.length === 0) return head;
  let body;
  try {
    body = JSON.stringify(data, null, 2);
  } catch {
    return head;
  }
  if (!body) return head;
  if (body.length > RENDER_DATA_MAX_CHARS) {
    body = `${body.slice(0, RENDER_DATA_MAX_CHARS)}\n…（data 已截断，完整内容见工作台文件）`;
  }
  return `${head}\n${body}`;
}
