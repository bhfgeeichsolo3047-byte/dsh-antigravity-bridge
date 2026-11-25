/**
 * dsh-agy-collab v2 — 产物契约
 *
 * 六目录里所有 Markdown 的 front-matter 解析与校验，以及 tasks.md 的三条机器硬检查。
 * 规格 §4.2 / §4.3 / §6.7 校验清单第 3 条。
 *
 * 零外部依赖：自己实现一个够用的 YAML 子集解析器（缩进块 + 行内数组 + 标量），
 * 只支持 front-matter 实际会出现的形状，不做通用 YAML。
 */

export const COMMON_FIELDS = Object.freeze(['task_id', 'stage', 'author', 'round', 'written_at']);
export const STAGES = Object.freeze(['request', 'plan', 'tasks', 'review', 'revision', 'final']);
export const AUTHORS = Object.freeze(['host', 'planner', 'executor', 'reviewer']);
export const VERDICTS = Object.freeze(['pass', 'needs_revision']);
export const SEVERITIES = Object.freeze(['blocker', 'high', 'medium', 'low']);

/** tasks.md 的 front-matter 只允许这些键（§4.3 第 1 条）。 */
export const TASKS_ALLOWED_KEYS = Object.freeze([...COMMON_FIELDS, 'requirements']);
/** 出现即违约的「实现过程」字段。 */
export const TASKS_FORBIDDEN_KEYS = Object.freeze(['steps', 'files', 'commands', 'tools', 'implementation', 'impl']);

const FORBIDDEN_IN_TASKS = Object.freeze(['steps', 'files', 'commands', 'tools']);

function stripComment(line) {
  // 只处理「不在引号里的 #」，够 front-matter 用。
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  if (text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d+\.\d+$/.test(text)) return Number(text);
  if ((text.startsWith("'") && text.endsWith("'") && text.length >= 2)) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return splitInline(inner).map((part) => parseScalar(part));
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return {};
    const out = {};
    for (const part of splitInline(inner)) {
      const idx = part.indexOf(':');
      if (idx < 0) continue;
      const key = part.slice(0, idx).trim();
      out[key] = parseScalar(part.slice(idx + 1));
    }
    return out;
  }
  return text;
}

function splitInline(text) {
  const out = [];
  let depth = 0;
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  for (const ch of text) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (ch === '[' || ch === '{') depth += 1;
      if (ch === ']' || ch === '}') depth -= 1;
      if (ch === ',' && depth === 0) {
        out.push(buf.trim());
        buf = '';
        continue;
      }
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function indentOf(line) {
  const m = /^( *)/.exec(line);
  return m ? m[1].length : 0;
}

/**
 * 解析缩进块：返回 [value, nextIndex]。
 * 支持 mapping 与 sequence 两种块，二者不能混在同一层。
 */
function parseBlock(lines, start, indent) {
  const isSeq = start < lines.length && lines[start].slice(indent).startsWith('- ');
  if (isSeq) return parseSeq(lines, start, indent);
  return parseMap(lines, start, indent);
}

function parseSeq(lines, start, indent) {
  const out = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) break;
    const body = line.slice(indent);
    if (!body.startsWith('- ')) break;
    const rest = body.slice(2);
    const trimmed = rest.trim();
    if (!trimmed) {
      i += 1;
      const childIndent = i < lines.length ? indentOf(lines[i]) : indent + 2;
      const [child, next] = parseBlock(lines, i, childIndent);
      out.push(child);
      i = next;
      continue;
    }
    const colon = trimmed.indexOf(':');
    const looksLikeMap = colon > 0 && !trimmed.startsWith('"') && !trimmed.startsWith("'")
      && /^[A-Za-z0-9_-]+:/.test(trimmed);
    if (looksLikeMap) {
      // 行内起始的 map 项：先解析第一对 k:v，再吃掉同项后续更深缩进的行。
      const item = {};
      const key = trimmed.slice(0, colon).trim();
      item[key] = parseScalar(trimmed.slice(colon + 1));
      i += 1;
      const childIndent = i < lines.length && lines[i].trim() ? indentOf(lines[i]) : indent + 2;
      if (i < lines.length && lines[i].trim() && childIndent > indent) {
        const [more, next] = parseMap(lines, i, childIndent);
        Object.assign(item, more);
        i = next;
      }
      out.push(item);
      continue;
    }
    out.push(parseScalar(trimmed));
    i += 1;
  }
  return [out, i];
}

function parseMap(lines, start, indent) {
  const out = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) break;
    const body = line.slice(indent);
    if (body.startsWith('- ')) break;
    const colon = body.indexOf(':');
    if (colon < 0) {
      i += 1;
      continue;
    }
    const key = body.slice(0, colon).trim();
    const valueText = body.slice(colon + 1).trim();
    if (valueText) {
      out[key] = parseScalar(valueText);
      i += 1;
      continue;
    }
    // 值为空 → 后面要么是更深缩进块，要么是空值。
    i += 1;
    if (i < lines.length && lines[i].trim() && indentOf(lines[i]) > indent) {
      const [child, next] = parseBlock(lines, i, indentOf(lines[i]));
      out[key] = child;
      i = next;
    } else {
      out[key] = null;
    }
  }
  return [out, i];
}

/** 解析 YAML 子集文本。 */
export function parseYaml(text) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const lines = raw.map((line) => stripComment(line)).filter((line, idx) => line.trim() || idx === 0 || true);
  const meaningful = lines.map((line) => line.replace(/\s+$/, ''));
  let i = 0;
  while (i < meaningful.length && !meaningful[i].trim()) i += 1;
  if (i >= meaningful.length) return {};
  const [value] = parseBlock(meaningful, i, indentOf(meaningful[i]));
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 拆 front-matter 与正文。
 * @returns {{ ok: boolean, data: object, body: string, error?: string }}
 */
export function splitFrontMatter(text) {
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---')) {
    return { ok: false, data: {}, body: src, error: '文件必须以 --- 开头的 front-matter 起始' };
  }
  const lines = src.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return { ok: false, data: {}, body: src, error: 'front-matter 没有闭合的 ---' };
  const head = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  let data;
  try {
    data = parseYaml(head);
  } catch (error) {
    return { ok: false, data: {}, body, error: `front-matter 解析失败：${error?.message ?? error}` };
  }
  return { ok: true, data, body };
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  return [v];
}

/** 校验通用五字段。 */
export function validateCommonFields(data, { stage, author, round } = {}) {
  const errors = [];
  if (!isNonEmptyString(data.task_id)) errors.push('缺少 task_id');
  if (!STAGES.includes(data.stage)) errors.push(`stage 非法：${String(data.stage)}`);
  else if (stage && data.stage !== stage) errors.push(`stage 应为 ${stage}，实际是 ${data.stage}`);
  if (!AUTHORS.includes(data.author)) errors.push(`author 非法：${String(data.author)}`);
  else if (author && data.author !== author) errors.push(`author 应为 ${author}，实际是 ${data.author}`);
  const r = Number(data.round);
  if (!Number.isInteger(r) || r < 0) errors.push(`round 必须是 >=0 的整数，实际是 ${String(data.round)}`);
  else if (round !== undefined && r !== Number(round)) errors.push(`round 应为 ${round}，实际是 ${r}`);
  if (!isNonEmptyString(data.written_at)) errors.push('缺少 written_at');
  return errors;
}

/** 校验 request.md。 */
export function validateRequest(data) {
  const errors = validateCommonFields(data, { stage: 'request', author: 'host', round: 0 });
  if (!isNonEmptyString(data.raw_text)) errors.push('request.md 缺少 raw_text');
  return { ok: errors.length === 0, errors };
}

/** 校验 plan.md（steps 数组，可选 subagent_count）。 */
export function validatePlan(data, { estimateSubagents = false } = {}) {
  const errors = validateCommonFields(data, { stage: 'plan', author: 'planner' });
  const steps = asArray(data.steps);
  if (!steps.length) errors.push('plan.md 缺少 steps');
  steps.forEach((step, idx) => {
    if (!step || typeof step !== 'object') {
      errors.push(`steps[${idx}] 不是对象`);
      return;
    }
    if (!isNonEmptyString(step.id)) errors.push(`steps[${idx}] 缺少 id`);
    if (!isNonEmptyString(step.purpose)) errors.push(`steps[${idx}] 缺少 purpose`);
    if (step.tools !== undefined && step.tools !== null) {
      const tools = asArray(step.tools);
      if (tools.some((t) => !isNonEmptyString(t))) errors.push(`steps[${idx}].tools 含非字符串项`);
    }
    if (estimateSubagents) {
      const n = Number(step.subagent_count);
      if (!Number.isInteger(n) || n < 0) errors.push(`steps[${idx}].subagent_count 开关打开时必须是 >=0 的整数`);
    }
  });
  return { ok: errors.length === 0, errors };
}

/**
 * tasks.md 的三条机器硬检查（§4.3）。
 * 命中任一条 → 停止 drafting、退回 Planner 重写、不占驳回轮次。
 */
export function checkTasksHardRules(data, body) {
  const errors = [];

  // 第 1 条：front-matter 只许 requirements[]，出现实现过程字段即违约。
  for (const key of Object.keys(data ?? {})) {
    if (TASKS_ALLOWED_KEYS.includes(key)) continue;
    if (TASKS_FORBIDDEN_KEYS.includes(key) || FORBIDDEN_IN_TASKS.includes(key)) {
      errors.push(`tasks.md 的 front-matter 不许出现 ${key}（任务清单只写目的与需求）`);
    } else {
      errors.push(`tasks.md 的 front-matter 出现未授权字段 ${key}`);
    }
  }

  const text = String(body ?? '');

  // 第 2 条：正文禁止代码围栏。
  if (/```/.test(text)) errors.push('tasks.md 正文禁止代码围栏');

  // 第 3 条：正文禁止表格与复选框。
  const tableLine = text.split('\n').find((line) => /^\s*\|.*\|\s*$/.test(line));
  if (tableLine !== undefined) errors.push('tasks.md 正文禁止表格');
  if (/^\s*-\s*\[[ xX]\]/m.test(text)) errors.push('tasks.md 正文禁止复选框');

  return { ok: errors.length === 0, errors };
}

/** 校验 tasks.md（通用字段 + 三条硬检查 + requirements 非空且 id 唯一）。 */
export function validateTasks(data, body) {
  const errors = validateCommonFields(data, { stage: 'tasks', author: 'planner' });
  const hard = checkTasksHardRules(data, body);
  errors.push(...hard.errors);
  const reqs = asArray(data.requirements);
  if (!reqs.length) errors.push('tasks.md 缺少 requirements');
  const seen = new Set();
  reqs.forEach((req, idx) => {
    if (!req || typeof req !== 'object') {
      errors.push(`requirements[${idx}] 不是对象`);
      return;
    }
    if (!isNonEmptyString(req.id)) errors.push(`requirements[${idx}] 缺少 id`);
    else if (seen.has(req.id)) errors.push(`requirements 的 id 重复：${req.id}`);
    else seen.add(req.id);
    if (!isNonEmptyString(req.text)) errors.push(`requirements[${idx}] 缺少 text`);
  });
  return { ok: errors.length === 0, errors, requirementIds: [...seen] };
}

/** 校验 revision-r<N>.md。 */
export function validateRevision(data, { round } = {}) {
  const errors = validateCommonFields(data, { stage: 'revision', author: 'planner', round });
  if (!isNonEmptyString(data.body ?? data.summary)) {
    // 正文本身不算字段，这里只提醒要有内容；正文空检查放在调用方。
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 校验 review-r<N>.md / final.md。
 * strict 档下 requirement_ref 必填且必须命中 tasks.md 的真实 id（不命中 = 幻觉引用 = 协议违规）。
 */
export function validateReview(data, { stage = 'review', round, mode = 'strict', requirementIds = [] } = {}) {
  const errors = validateCommonFields(data, { stage, author: 'reviewer', round });
  if (!VERDICTS.includes(data.verdict)) {
    errors.push(`verdict 必须是 pass 或 needs_revision，实际是 ${String(data.verdict)}`);
  }
  const findings = asArray(data.findings).filter((f) => f !== null && f !== undefined);
  if (data.verdict === 'needs_revision' && findings.length === 0) {
    errors.push('verdict 为 needs_revision 时必须给出 findings');
  }
  if (data.verdict === 'pass' && findings.length > 0) {
    errors.push('verdict 为 pass 时不应带 findings');
  }
  const known = new Set(requirementIds.map((v) => String(v)));
  findings.forEach((f, idx) => {
    if (!f || typeof f !== 'object') {
      errors.push(`findings[${idx}] 不是对象`);
      return;
    }
    if (!isNonEmptyString(f.id)) errors.push(`findings[${idx}] 缺少 id`);
    if (!isNonEmptyString(f.problem)) errors.push(`findings[${idx}] 缺少 problem`);
    if (!isNonEmptyString(f.required_fix)) errors.push(`findings[${idx}] 缺少 required_fix（这是驳回可执行的前提）`);
    if (f.severity !== undefined && f.severity !== null && !SEVERITIES.includes(f.severity)) {
      errors.push(`findings[${idx}].severity 非法：${String(f.severity)}`);
    }
    const ref = f.requirement_ref;
    if (mode === 'strict') {
      if (!isNonEmptyString(ref)) {
        errors.push(`findings[${idx}] 严格档下 requirement_ref 必填`);
      } else if (known.size > 0 && !known.has(String(ref))) {
        errors.push(`findings[${idx}].requirement_ref "${ref}" 在 tasks.md 里不存在（幻觉引用）`);
      }
    } else if (ref !== undefined && ref !== null && ref !== '' && known.size > 0 && !known.has(String(ref))) {
      errors.push(`findings[${idx}].requirement_ref "${ref}" 在 tasks.md 里不存在（幻觉引用）`);
    }
  });
  return { ok: errors.length === 0, errors, findings };
}

/**
 * 按 slot 分派校验。
 * @param {{ slot: string, text: string, round?: number, mode?: string, requirementIds?: string[], estimateSubagents?: boolean }} input
 * @returns {{ ok: boolean, errors: string[], data: object, body: string }}
 */
export function validateArtifact({ slot, text, round, mode = 'strict', requirementIds = [], estimateSubagents = false } = {}) {
  const split = splitFrontMatter(text);
  if (!split.ok) return { ok: false, errors: [split.error], data: {}, body: split.body };
  const { data, body } = split;
  let result;
  if (slot === 'request') result = validateRequest(data);
  else if (slot === 'plan') result = validatePlan(data, { estimateSubagents });
  else if (slot === 'tasks') result = validateTasks(data, body);
  else if (slot === 'revision') result = validateRevision(data, { round });
  else if (slot === 'review') result = validateReview(data, { stage: 'review', round, mode, requirementIds });
  else if (slot === 'final') result = validateReview(data, { stage: 'final', round, mode, requirementIds });
  else return { ok: false, errors: [`unknown slot "${slot}"`], data, body };
  const errors = [...result.errors];
  if (slot !== 'request' && !String(body).trim()) errors.push(`${slot} 的正文不能为空`);
  return { ok: errors.length === 0, errors, data, body, ...(result.requirementIds ? { requirementIds: result.requirementIds } : {}) };
}
