/**
 * v2 工具定义与真实宿主 defineTool 的契约测试（A 审核第二轮阻塞 ①）。
 *
 * 这里不 mock defineTool：本机存在 DSH 安装树时直接 import 真的 dsh-tools，
 * 让 JsonSchemaError 真的有机会抛出来。安装树不存在则整组 skip（CI 或换机器）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  TOOL_NAMES,
  TOOL_OUTPUT_SCHEMA,
  TOOL_SPECS,
  buildToolDefinitions,
  compileParameterSchemaSpec,
  renderToolResult,
  toParameterSchemaSpec,
} from '../../plugin/dsh-agy-collab/lib/v2/tools.js';

const START_SPEC = {
  name: 'collab_start',
  description: '开一个新任务（测试用）',
  parameters: {
    type: 'object',
    properties: {
      request: { type: 'string', description: '原始需求' },
      purpose: { type: 'string', description: '目的' },
    },
    required: ['request'],
  },
};

const ALL_HANDLERS = Object.freeze({
  [TOOL_NAMES.write]: async () => ({ ok: true, message: 'w' }),
  [TOOL_NAMES.submit]: async () => ({ ok: true, message: 's' }),
  [TOOL_NAMES.blocked]: async () => ({ ok: true, message: 'b' }),
  [TOOL_NAMES.abort]: async () => ({ ok: true, message: 'a' }),
  collab_start: async () => ({ ok: true, message: 'start' }),
});

/** 本机 DSH 安装树里的 dsh-tools（存在才跑真实契约）。 */
function resolveRealDshTools() {
  const candidates = [
    process.env.DSH_TOOLS_PATH,
    'G:/鱼塘/resources/app/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
    'G:/鱼塘/resources/app/dsh/node_modules/@deepseek-ai/dsh-tools/dist/index.js',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

test('toParameterSchemaSpec 把 JSON Schema 形状转成宿主属性映射', () => {
  const spec = toParameterSchemaSpec({
    type: 'object',
    properties: {
      a: { type: 'string', description: 'x' },
      b: { type: 'number' },
    },
    required: ['a'],
  });
  // 关键：不能留 type / properties / required 外壳，否则宿主报 parameters.type must be a value schema object
  assert.equal(Object.hasOwn(spec, 'type'), false);
  assert.equal(Object.hasOwn(spec, 'properties'), false);
  assert.equal(Object.hasOwn(spec, 'required'), false);
  assert.deepEqual(Object.keys(spec).sort(), ['a', 'b']);
  assert.equal(spec.a.required, true);
  assert.equal(Object.hasOwn(spec.b, 'required'), false);
  assert.equal(spec.a.type, 'string');
});

test('compileParameterSchemaSpec 是反向：属性映射 → 裸 JSON Schema', () => {
  const spec = { a: { type: 'string', required: true }, b: { type: 'number' } };
  const schema = compileParameterSchemaSpec(spec);
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['a']);
  assert.equal(Object.hasOwn(schema.properties.a, 'required'), false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['a', 'b']);
});

test('output schema 是 value schema DSL：显式 additionalProperties、data 用 json', () => {
  assert.equal(TOOL_OUTPUT_SCHEMA.type, 'object');
  assert.equal(TOOL_OUTPUT_SCHEMA.additionalProperties, false);
  assert.equal(Object.hasOwn(TOOL_OUTPUT_SCHEMA, 'required'), false);
  assert.equal(TOOL_OUTPUT_SCHEMA.properties.ok.required, true);
  assert.equal(TOOL_OUTPUT_SCHEMA.properties.message.required, true);
  assert.equal(TOOL_OUTPUT_SCHEMA.properties.data.type, 'json');
});

test('五个工具经 buildToolDefinitions 后 parameters 都是属性映射、render 返回 ContentBlock[]', () => {
  const seen = [];
  const fakeDefineTool = (options) => {
    seen.push(options);
    return { name: options.name, description: options.description };
  };
  const defs = buildToolDefinitions({
    defineTool: fakeDefineTool,
    handlers: ALL_HANDLERS,
    extraSpecs: [START_SPEC],
  });
  assert.equal(defs.length, 5);
  for (const options of seen) {
    assert.equal(Object.hasOwn(options.parameters, 'type'), false, `${options.name} 的 parameters 不该有 type 外壳`);
    assert.equal(Object.hasOwn(options.parameters, 'properties'), false);
    const blocks = options.output.render({}, { ok: true, message: 'ok' });
    assert.ok(Array.isArray(blocks), `${options.name} 的 render 必须返回数组`);
    assert.equal(blocks[0].type, 'text');
    assert.equal(typeof blocks[0].text, 'string');
  }
});

test('真实 dsh-tools 的 defineTool 能吃下全部五个工具，零 JsonSchemaError', async (t) => {
  const realPath = resolveRealDshTools();
  if (!realPath) {
    t.skip('本机没有 DSH 安装树，跳过真实契约测试');
    return;
  }
  const mod = await import(new URL(`file://${realPath.replace(/\\/g, '/')}`).href);
  assert.equal(typeof mod.defineTool, 'function', '真实 dsh-tools 必须导出 defineTool');
  const defs = buildToolDefinitions({
    defineTool: mod.defineTool,
    handlers: ALL_HANDLERS,
    extraSpecs: [START_SPEC],
  });
  assert.equal(defs.length, 5);
  for (const def of defs) {
    assert.equal(typeof def.name, 'string');
    // 编译后的 parameters 必须是裸 JSON Schema（宿主内部转换的结果）
    assert.equal(def.parameters.type, 'object');
    assert.equal(def.output.schema.type, 'object');
    assert.equal(def.output.schema.additionalProperties, false);
    const blocks = def.output.render({}, { ok: false, message: 'x' });
    assert.deepEqual(blocks, [{ type: 'text', text: renderToolResult({ ok: false, message: 'x' }) }]);
  }
});

test('真实 defineTool 会用参数校验拦住非法调用', async (t) => {
  const realPath = resolveRealDshTools();
  if (!realPath) {
    t.skip('本机没有 DSH 安装树，跳过');
    return;
  }
  const mod = await import(new URL(`file://${realPath.replace(/\\/g, '/')}`).href);
  const defs = buildToolDefinitions({ defineTool: mod.defineTool, handlers: ALL_HANDLERS });
  const writeTool = defs.find((d) => d.name === TOOL_NAMES.write);
  assert.ok(writeTool);
  // 缺必填参数必须被宿主校验拒掉，而不是把 undefined 传进处理器
  await assert.rejects(() => writeTool.execute({}, {}), (error) => {
    assert.match(String(error?.message ?? error), /invalid arguments|INVALID_ARGS/i);
    return true;
  });
});