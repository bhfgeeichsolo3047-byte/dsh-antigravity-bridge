import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { syncPlugin } from './sync-plugin.mjs';
import {
  applyTemplateSync,
  inspectTemplates,
  planTemplateSync,
} from './template-sync.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const collabDir = path.join(dshHome, 'agy-collab');
  const collabDirPosix = collabDir.replace(/\\/g, '/');
  const geminiConfigDir = process.env.GEMINI_CONFIG_DIR || path.join(os.homedir(), '.gemini', 'config');
  const templateSrcDir = path.join(REPO_ROOT, 'antigravity', 'rules', 'dsh-collab');

  const tag = dryRun ? '(dry-run) would' : '';

  console.log(`[install] mode=${dryRun ? 'dry-run' : 'apply'}`);
  console.log(`[install] collabDir=${collabDir}`);
  console.log(`[install] geminiConfigDir=${geminiConfigDir}`);

  // 1. Deploy broker & CLI scripts
  if (!dryRun) fs.mkdirSync(collabDir, { recursive: true });
  for (const name of ['broker.mjs', 'wait-next-request.mjs', 'reply-request.mjs']) {
    const src = path.join(REPO_ROOT, 'broker', name);
    const dest = path.join(collabDir, name);
    if (!dryRun) fs.copyFileSync(src, dest);
    console.log(`[install] ${tag} copy ${name} -> ${dest}`);
  }

  // 2. Sync DSH plugin to ~/.dsh/agy-collab and DSH profiles
  syncPlugin({ dshHome, dryRun });

  // 3. A-side role templates, declarative via manifest (spec §11.3 / §11.3.1)
  const plan = planTemplateSync({ geminiConfigDir, srcDir: templateSrcDir, collabDirPosix });

  if (plan.firstRun) {
    console.log(
      `[install] 首次迁移：manifest ${plan.manifestKind}（${plan.manifestReason}），先清理 v1 遗留物`,
    );
    for (const legacy of plan.legacy) {
      const exists = fs.existsSync(legacy.dest);
      console.log(`[install] ${tag} delete ${legacy.relPath}${exists ? '' : '（不存在，跳过）'}`);
    }
  }

  for (const d of plan.deletes) {
    const exists = fs.existsSync(d.dest);
    console.log(`[install] ${tag} delete ${d.relPath}${exists ? '' : '（已不存在）'}`);
  }

  const done = applyTemplateSync(plan, { dryRun });
  for (const w of plan.writes) {
    const ver = w.templateVersion ? ` (template_version=${w.templateVersion})` : '';
    console.log(`[install] ${tag} write ${w.relPath}${ver} sha256=${w.sha256.slice(0, 12)}`);
  }
  console.log(`[install] ${tag} write manifest -> ${done.manifest}`);

  // 4. 收尾自检：装完必须判为 installed，否则这次安装是半成品
  if (!dryRun) {
    const view = inspectTemplates({ geminiConfigDir, srcDir: templateSrcDir, collabDirPosix });
    console.log(`[install] templates status=${view.status}`);
    for (const item of view.items) {
      console.log(`[install]   ${item.relPath} state=${item.state}`);
    }
    if (view.legacyPresent.length > 0) {
      console.log(`[install]   WARNING 仍有 v1 遗留物：${view.legacyPresent.join(', ')}`);
    }
    if (view.status !== 'installed') {
      console.error('[install] 安装后自检未通过：A 侧规则可能仍是旧的，请检查上面的逐项状态。');
      process.exitCode = 1;
      return;
    }
  }

  console.log('[install] done.');
}

main();
