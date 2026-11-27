import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  WORKSPACE_DIRS,
  SLOT_ORDER,
  allowedFileNames,
  assertSnapshotDelta,
  collectRepoGitEvidence,
  createWorkspace,
  diffSnapshot,
  filePath,
  isPidAlive,
  parseHostDirName,
  removeHostTree,
  roundFileName,
  snapshotTree,
  sweepOrphans,
  workspacePath,
} from '../../plugin/dsh-agy-collab/lib/v2/workspace.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agy-v2-ws-'));
}

test('六个子目录按顺序建出来', () => {
  const root = tmpRoot();
  const paths = createWorkspace({ root, hostPid: 111, bootId: 'abcdef', sessionId: 's1', taskId: 't1' });
  for (const slot of SLOT_ORDER) {
    assert.ok(fs.existsSync(paths.dirs[slot]), `缺目录 ${slot}`);
  }
  assert.equal(SLOT_ORDER.length, 6);
  assert.equal(Object.keys(WORKSPACE_DIRS).length, 6);
  assert.ok(paths.taskRoot.endsWith(path.join('111-abcdef', 's1', 't1')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('路径段不许带分隔符，防止逃逸', () => {
  const root = tmpRoot();
  assert.throws(() => workspacePath({ root, hostPid: 1, bootId: 'abcdef', sessionId: '../evil', taskId: 't' }));
  assert.throws(() => workspacePath({ root, hostPid: 1, bootId: 'abcdef', sessionId: 's', taskId: 'a/b' }));
  fs.rmSync(root, { recursive: true, force: true });
});

test('带轮次的文件名与允许清单', () => {
  assert.equal(roundFileName('review', 2), 'review-r2.md');
  assert.equal(roundFileName('revision', 1), 'revision-r1.md');
  assert.throws(() => roundFileName('plan', 1));
  assert.deepEqual(allowedFileNames('plan'), ['plan.md']);
  assert.deepEqual(allowedFileNames('tasks'), ['tasks.md']);
  assert.deepEqual(allowedFileNames('review', { round: 3 }), ['review-r3.md']);
  assert.deepEqual(allowedFileNames('final'), ['final.md']);
  assert.deepEqual(allowedFileNames('executor'), []);
});

test('孤儿清扫：死 pid 删、异 boot-id 删、活兄弟保留', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '999999-dead01'), { recursive: true });
  fs.mkdirSync(path.join(root, '888888-other1'), { recursive: true });
  fs.mkdirSync(path.join(root, `${process.pid}-live01`), { recursive: true });
  fs.mkdirSync(path.join(root, 'not-a-host-dir'), { recursive: true });

  const alive = (pid) => pid === process.pid;
  const result = sweepOrphans({ root, bootId: 'live01', isAlive: alive });
  assert.deepEqual(result.removed.sort(), ['888888-other1', '999999-dead01']);
  assert.deepEqual(result.kept, [`${process.pid}-live01`]);
  assert.deepEqual(result.skipped, ['not-a-host-dir']);
  assert.equal(fs.existsSync(path.join(root, '999999-dead01')), false);
  assert.equal(fs.existsSync(path.join(root, `${process.pid}-live01`)), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('清扫时 pid 被复用也不误删：boot-id 不同照样删', () => {
  const root = tmpRoot();
  // 活着的 pid，但 boot-id 是上一次开机的 → 仍是残骸
  fs.mkdirSync(path.join(root, `${process.pid}-oldboot`), { recursive: true });
  const result = sweepOrphans({ root, bootId: 'newboot', isAlive: () => true });
  assert.deepEqual(result.removed, [`${process.pid}-oldboot`]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Host 退出只删自己那一棵，不碰兄弟', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '111-aaaaaa'), { recursive: true });
  fs.mkdirSync(path.join(root, '222-bbbbbb'), { recursive: true });
  const result = removeHostTree({ root, hostPid: 111, bootId: 'aaaaaa' });
  assert.equal(result.removed, true);
  assert.equal(fs.existsSync(path.join(root, '111-aaaaaa')), false);
  assert.equal(fs.existsSync(path.join(root, '222-bbbbbb')), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('目录名解析', () => {
  assert.deepEqual(parseHostDirName('39812-3f9a1c'), { pid: 39812, bootId: '3f9a1c' });
  assert.equal(parseHostDirName('39812'), null);
  assert.equal(parseHostDirName('39812-!!'), null);
  assert.equal(parseHostDirName('abc-3f9a1c'), null);
});

test('快照 diff：新增 / 变化 / 删除三组', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '01-x'), { recursive: true });
  fs.writeFileSync(path.join(root, '01-x', 'a.md'), 'v1');
  const before = snapshotTree(root);
  fs.writeFileSync(path.join(root, '01-x', 'a.md'), 'v2');
  fs.writeFileSync(path.join(root, '01-x', 'b.md'), 'new');
  const after = snapshotTree(root);
  const delta = diffSnapshot(before, after);
  assert.deepEqual(delta.added, ['01-x/b.md']);
  assert.deepEqual(delta.changed, ['01-x/a.md']);
  assert.deepEqual(delta.removed, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('越权判定：差集必须恰好是允许的那个文件', () => {
  const root = tmpRoot();
  const paths = createWorkspace({ root, hostPid: 1, bootId: 'aaaaaa', sessionId: 's', taskId: 't' });
  const target = filePath(paths, 'plan', 'plan.md');
  const allowedRel = [path.relative(paths.taskRoot, target).split(path.sep).join('/')];

  const before = snapshotTree(paths.taskRoot);
  fs.writeFileSync(target, 'plan');
  const after = snapshotTree(paths.taskRoot);
  const clean = assertSnapshotDelta(before, after, allowedRel);
  assert.equal(clean.ok, true, clean.extras.join('、'));

  // 多写一个文件 = 越权
  fs.writeFileSync(filePath(paths, 'tasks', 'tasks.md'), 'tasks');
  const after2 = snapshotTree(paths.taskRoot);
  const dirty = assertSnapshotDelta(before, after2, allowedRel);
  assert.equal(dirty.ok, false);
  assert.deepEqual(dirty.extras, ['03-任务清单/tasks.md']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('collectRepoGitEvidence 拼出 status / stat / diff 三段', () => {
  const calls = [];
  const runGit = (_cwd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'status') return ' M src/a.js\n';
    if (args[0] === 'diff' && args.includes('--stat')) return ' src/a.js | 2 +-\n';
    if (args[0] === 'diff') return 'diff --git a/src/a.js b/src/a.js\n+// 改了一行\n';
    return '';
  };
  const text = collectRepoGitEvidence('/repo', { runGit });
  assert.deepEqual(calls, ['status --porcelain', 'diff --stat HEAD', 'diff HEAD']);
  assert.match(text, /--- git status --porcelain ---/);
  assert.match(text, /--- git diff --stat HEAD ---/);
  assert.match(text, /--- git diff HEAD ---/);
  assert.match(text, /改了一行/);
});

test('collectRepoGitEvidence 超长 diff 截断并注明总长度', () => {
  const runGit = (_cwd, args) => {
    if (args[0] === 'status') return ' M src/a.js\n';
    if (args[0] === 'diff' && args.includes('--stat')) return '';
    return 'x'.repeat(500);
  };
  const text = collectRepoGitEvidence('/repo', { runGit, maxDiffChars: 100 });
  assert.match(text, /已截断到 100 字符，共 500/);
  assert.equal(text.includes('x'.repeat(101)), false);
});

test('collectRepoGitEvidence 非 git 目录 / 空 cwd 都返回空串，不抛错', () => {
  assert.equal(collectRepoGitEvidence('', { runGit: () => '' }), '');
  assert.equal(collectRepoGitEvidence('/repo', { runGit: () => '' }), '');
  const thrower = () => {
    throw new Error('not a git repository');
  };
  assert.equal(collectRepoGitEvidence('/repo', { runGit: thrower }), '');
});

test('isPidAlive 对当前进程为真，对不可能存在的 pid 为假', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive('abc'), false);
});
