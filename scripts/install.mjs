import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { syncPlugin } from './sync-plugin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const collabDir = path.join(dshHome, 'agy-collab');
  const collabDirPosix = collabDir.replace(/\\/g, '/');
  const geminiConfigDir = process.env.GEMINI_CONFIG_DIR || path.join(os.homedir(), '.gemini', 'config');

  console.log(`[install] mode=${dryRun ? 'dry-run' : 'apply'}`);
  console.log(`[install] collabDir=${collabDir}`);
  console.log(`[install] geminiConfigDir=${geminiConfigDir}`);

  // 1. Deploy broker & CLI scripts
  if (!dryRun) fs.mkdirSync(collabDir, { recursive: true });
  for (const name of ['broker.mjs', 'wait-next-request.mjs', 'reply-request.mjs']) {
    const src = path.join(REPO_ROOT, 'broker', name);
    const dest = path.join(collabDir, name);
    if (!dryRun) fs.copyFileSync(src, dest);
    console.log(`[install] ${dryRun ? '(dry-run) would copy' : 'copied'} ${name} -> ${dest}`);
  }

  // 2. Sync DSH plugin to ~/.dsh/agy-collab and DSH profiles
  syncPlugin({ dshHome, dryRun });

  // 3. Install Antigravity global rule & skill with resolved collab directory path
  const ruleSrc = path.join(REPO_ROOT, 'antigravity', 'rules', 'dsh-collab-protocol.md');
  const ruleDest = path.join(geminiConfigDir, 'rules', 'dsh-collab-protocol.md');
  const ruleContent = fs.readFileSync(ruleSrc, 'utf8').replaceAll('~/.dsh/agy-collab', collabDirPosix);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(ruleDest), { recursive: true });
    fs.writeFileSync(ruleDest, ruleContent, 'utf8');
  }
  console.log(`[install] ${dryRun ? '(dry-run) would write' : 'wrote'} rule -> ${ruleDest}`);

  const skillSrc = path.join(REPO_ROOT, 'antigravity', 'skills', 'dsh-collab', 'SKILL.md');
  const skillDest = path.join(geminiConfigDir, 'skills', 'dsh-collab', 'SKILL.md');
  const skillContent = fs.readFileSync(skillSrc, 'utf8').replaceAll('~/.dsh/agy-collab', collabDirPosix);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(skillDest), { recursive: true });
    fs.writeFileSync(skillDest, skillContent, 'utf8');
  }
  console.log(`[install] ${dryRun ? '(dry-run) would write' : 'wrote'} skill -> ${skillDest}`);

  console.log('[install] done.');
}

main();
