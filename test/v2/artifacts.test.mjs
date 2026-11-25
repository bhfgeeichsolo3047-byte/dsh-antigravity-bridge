import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitFrontMatter,
  validateArtifact,
  checkTasksHardRules,
  validateTasks,
  validatePlan,
  validateReview,
  parseYaml,
} from '../../plugin/dsh-agy-collab/lib/v2/artifacts.js';

const FM = (extra) => `---
task_id: t-1
stage: EXTRA_STAGE
author: EXTRA_AUTHOR
round: EXTRA_ROUND
written_at: 2026-11-25T19:52:04+08:00
EXTRA
---
`;

function tasksDoc({ requirements = '  - id: R1\n    text: 第一条\n  - id: R2\n    text: 第二条', extra = '', body = '## R1\n做这个。\n' } = {}) {
  return [
    '---',
    'task_id: t-1',
    'stage: tasks',
    'author: planner',
    'round: 0',
    'written_at: 2026-11-25T19:52:04+08:00',
    extra,
    'requirements:',
    requirements,
    '---',
    '',
    body,
  ].filter((l) => l !== '').join('\n');
}

function reviewDoc({ verdict = 'needs_revision', findings = '  - id: F1\n    requirement_ref: R1\n    severity: high\n    problem: 没做\n    required_fix: 补上', round = 1, stage = 'review' } = {}) {
  return [
    '---',
    'task_id: t-1',
    `stage: ${stage}`,
    'author: reviewer',
    `round: ${round}`,
    'written_at: 2026-11-25T19:52:04+08:00',
    `verdict: ${verdict}`,
    'findings:',
    findings,
    '---',
    '',
    '审核正文。',
  ].join('\n');
}

test('front-matter 拆分：缺开头 / 缺闭合都要报错', () => {
  assert.equal(splitFrontMatter('没有 front-matter').ok, false);
  assert.equal(splitFrontMatter('---\na: 1\n').ok, false);
  const ok = splitFrontMatter('---\na: 1\n---\n正文');
  assert.equal(ok.ok, true);
  assert.equal(ok.data.a, 1);
  assert.equal(ok.body.trim(), '正文');
});

test('YAML 子集解析：嵌套 map / 数组 / 行内数组 / 引号', () => {
  const parsed = parseYaml([
    'name: abc',
    'count: 3',
    'flag: true',
    'empty:',
    'list:',
    '  - id: A',
    '    text: 甲',
    '  - id: B',
    '    text: 乙',
    'inline: [x, y, 3]',
    'quoted: "a: b"',
  ].join('\n'));
  assert.equal(parsed.name, 'abc');
  assert.equal(parsed.count, 3);
  assert.equal(parsed.flag, true);
  assert.equal(parsed.empty, null);
  assert.deepEqual(parsed.list, [{ id: 'A', text: '甲' }, { id: 'B', text: '乙' }]);
  assert.deepEqual(parsed.inline, ['x', 'y', 3]);
  assert.equal(parsed.quoted, 'a: b');
});

test('tasks.md 三条硬检查：front-matter 出现实现过程字段即违约', () => {
  const doc = tasksDoc({ extra: 'steps:\n  - id: S1\n    purpose: x' });
  const result = validateArtifact({ slot: 'tasks', text: doc });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /不许出现 steps/);
});

test('tasks.md 三条硬检查：正文禁代码围栏', () => {
  const doc = tasksDoc({ body: '## R1\n\n```js\ncode\n```\n' });
  const result = validateArtifact({ slot: 'tasks', text: doc });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /代码围栏/);
});

test('tasks.md 三条硬检查：正文禁表格与复选框', () => {
  const table = validateArtifact({ slot: 'tasks', text: tasksDoc({ body: '| a | b |\n| - | - |\n' }) });
  assert.equal(table.ok, false);
  assert.match(table.errors.join(' '), /禁止表格/);

  const checkbox = validateArtifact({ slot: 'tasks', text: tasksDoc({ body: '- [ ] 未做\n' }) });
  assert.equal(checkbox.ok, false);
  assert.match(checkbox.errors.join(' '), /禁止复选框/);
});

test('tasks.md 合格样例通过，并给出 requirementIds', () => {
  const result = validateArtifact({ slot: 'tasks', text: tasksDoc() });
  assert.equal(result.ok, true, result.errors.join('；'));
  assert.deepEqual(result.requirementIds, ['R1', 'R2']);
});

test('tasks.md requirements id 重复要报错', () => {
  const result = validateArtifact({ slot: 'tasks', text: tasksDoc({ requirements: '  - id: R1\n    text: a\n  - id: R1\n    text: b' }) });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /id 重复/);
});

test('plan.md：steps 必须有 id 与 purpose；subagent_count 只在开关打开时校验', () => {
  const doc = [
    '---',
    'task_id: t-1',
    'stage: plan',
    'author: planner',
    'round: 0',
    'written_at: 2026-11-25T19:52:04+08:00',
    'steps:',
    '  - id: S1',
    '    purpose: 读配置',
    '    tools: [read, grep]',
    '---',
    '',
    '方案正文。',
  ].join('\n');
  assert.equal(validateArtifact({ slot: 'plan', text: doc }).ok, true);

  const withCount = doc.replace('    tools: [read, grep]', '    tools: [read, grep]\n    subagent_count: 2');
  assert.equal(validateArtifact({ slot: 'plan', text: withCount }).ok, true, '开关关闭时不校验 subagent_count');
  const estimate = validateArtifact({ slot: 'plan', text: withCount, estimateSubagents: true });
  assert.equal(estimate.ok, true);

  const badCount = doc.replace('    tools: [read, grep]', '    tools: [read, grep]\n    subagent_count: abc');
  const est2 = validateArtifact({ slot: 'plan', text: badCount, estimateSubagents: true });
  assert.equal(est2.ok, false);
  assert.match(est2.errors.join(' '), /subagent_count/);
});

test('review：pass 不带 findings，needs_revision 必须带', () => {
  const pass = validateArtifact({ slot: 'review', text: reviewDoc({ verdict: 'pass', findings: '  - id: F1\n    requirement_ref: R1\n    problem: x\n    required_fix: y' }), round: 1, requirementIds: ['R1'] });
  assert.equal(pass.ok, false);
  assert.match(pass.errors.join(' '), /不应带 findings/);

  const noFindings = validateArtifact({ slot: 'review', text: reviewDoc({ findings: '' }), round: 1, requirementIds: ['R1'] });
  assert.equal(noFindings.ok, false);
  assert.match(noFindings.errors.join(' '), /必须给出 findings/);
});

test('review：严格档 requirement_ref 必填且必须命中 tasks.md', () => {
  const missing = reviewDoc().replace('    requirement_ref: R1\n', '');
  const strictMissing = validateArtifact({ slot: 'review', text: missing, round: 1, requirementIds: ['R1'], mode: 'strict' });
  assert.equal(strictMissing.ok, false);
  assert.match(strictMissing.errors.join(' '), /requirement_ref 必填/);

  const hallucinated = reviewDoc().replace('requirement_ref: R1', 'requirement_ref: R9');
  const strictHallu = validateArtifact({ slot: 'review', text: hallucinated, round: 1, requirementIds: ['R1'], mode: 'strict' });
  assert.equal(strictHallu.ok, false);
  assert.match(strictHallu.errors.join(' '), /幻觉引用/);

  const looseHallu = validateArtifact({ slot: 'review', text: hallucinated, round: 1, requirementIds: ['R1'], mode: 'loose' });
  assert.equal(looseHallu.ok, false, '宽松档命中不存在的 id 也算幻觉');
});

test('review：缺 required_fix 是协议违规（驳回无法执行）', () => {
  const doc = reviewDoc().replace('    required_fix: 补上\n', '');
  const result = validateArtifact({ slot: 'review', text: doc, round: 1, requirementIds: ['R1'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /required_fix/);
});

test('review：stage / author / round 与预期不符要报错', () => {
  const wrongAuthor = reviewDoc().replace('author: reviewer', 'author: planner');
  const result = validateArtifact({ slot: 'review', text: wrongAuthor, round: 1, requirementIds: ['R1'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /author 应为 reviewer/);
});

test('final 走同一套审核校验，stage 必须是 final', () => {
  const ok = validateArtifact({ slot: 'final', text: reviewDoc({ stage: 'final', verdict: 'pass', findings: '', round: 3 }), round: 3, requirementIds: ['R1'] });
  assert.equal(ok.ok, true, ok.errors.join('；'));
});

test('正文为空要报错（request 除外）', () => {
  const empty = validateArtifact({ slot: 'tasks', text: tasksDoc({ body: '   ' }) });
  assert.equal(empty.ok, false);
  assert.match(empty.errors.join(' '), /正文不能为空/);
});

test('request.md 必须有 raw_text', () => {
  const doc = ['---', 'task_id: t-1', 'stage: request', 'author: host', 'round: 0', 'written_at: 2026-11-25T19:52:04+08:00', '---', '', '正文'].join('\n');
  const result = validateArtifact({ slot: 'request', text: doc });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /raw_text/);
});

test('checkTasksHardRules 单独可用（供 collab_write 早失败）', () => {
  const data = { task_id: 't', stage: 'tasks', author: 'planner', round: 0, written_at: 'x', requirements: [{ id: 'R1', text: 'a' }] };
  assert.equal(checkTasksHardRules(data, '正文').ok, true);
  const withTable = checkTasksHardRules(data, '| a | b |\n');
  assert.equal(withTable.ok, false);
});

test('validateTasks / validatePlan / validateReview 直接调用也能用', () => {
  assert.equal(validateTasks({ task_id: 't', stage: 'tasks', author: 'planner', round: 0, written_at: 'x', requirements: [{ id: 'R1', text: 'a' }] }, '正文').ok, true);
  assert.equal(validatePlan({ task_id: 't', stage: 'plan', author: 'planner', round: 0, written_at: 'x', steps: [{ id: 'S1', purpose: 'p' }] }).ok, true);
  assert.equal(validateReview({ task_id: 't', stage: 'review', author: 'reviewer', round: 1, written_at: 'x', verdict: 'pass' }, { round: 1, requirementIds: ['R1'] }).ok, true);
});
