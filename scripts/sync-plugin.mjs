import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_PLUGIN_SRC = path.join(REPO_ROOT, 'plugin', 'dsh-agy-collab');
const PROFILES = ['desktop', 'web', 'headless'];

export function copyDirRecursive(src, dest, dryRun = false) {
  if (!dryRun) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d, dryRun);
    } else if (!dryRun) {
      fs.copyFileSync(s, d);
    }
  }
}

export function syncPlugin({
  dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  pluginSrc = DEFAULT_PLUGIN_SRC,
  dryRun = false,
} = {}) {
  const collabPluginDir = path.join(dshHome, 'agy-collab', 'dsh-agy-collab');
  copyDirRecursive(pluginSrc, collabPluginDir, dryRun);
  console.log(`[sync] ${dryRun ? '(dry-run) would copy' : 'copied'} plugin -> ${collabPluginDir}`);

  for (const profile of PROFILES) {
    const profileDir = path.join(dshHome, 'profiles', profile);
    if (!fs.existsSync(profileDir)) continue;

    const targetModDir = path.join(profileDir, 'node_modules', 'dsh-agy-collab');
    copyDirRecursive(pluginSrc, targetModDir, dryRun);
    console.log(`[sync] ${dryRun ? '(dry-run) would copy' : 'copied'} dsh-agy-collab -> ${targetModDir}`);

    const pkgPath = path.join(profileDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg.dependencies = pkg.dependencies || {};
      let changed = false;
      if (pkg.dependencies['dsh-agy-collab'] !== 'file:./node_modules/dsh-agy-collab') {
        pkg.dependencies['dsh-agy-collab'] = 'file:./node_modules/dsh-agy-collab';
        changed = true;
      }
      pkg.dsh = pkg.dsh || {};
      pkg.dsh.profile = pkg.dsh.profile || {};
      pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
      if (!pkg.dsh.profile.bundles.includes('dsh-agy-collab')) {
        pkg.dsh.profile.bundles.push('dsh-agy-collab');
        changed = true;
      }
      if (changed) {
        if (!dryRun) {
          fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
        }
        console.log(`[sync] ${dryRun ? '(dry-run) would register' : 'registered'} dsh-agy-collab in ${pkgPath}`);
      } else {
        console.log(`[sync] ${pkgPath} already has dsh-agy-collab`);
      }
    }

    const patchPath = path.join(profileDir, 'cordis.patch.yml');
    if (fs.existsSync(patchPath)) {
      let yml = fs.readFileSync(patchPath, 'utf8');
      const stamp = `# hmr-sync-dsh-agy-collab: ${new Date().toISOString()}`;
      if (/^# hmr-sync-dsh-agy-collab:.*$/m.test(yml)) {
        yml = yml.replace(/^# hmr-sync-dsh-agy-collab:.*$/m, stamp);
      } else {
        yml = yml.replace(/\s*$/, '') + '\n' + stamp + '\n';
      }
      if (!dryRun) {
        fs.writeFileSync(patchPath, yml, 'utf8');
      }
      console.log(`[sync] ${dryRun ? '(dry-run) would touch' : 'touched'} ${patchPath} to trigger HMR`);
    }
  }
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const dryRun = process.argv.includes('--dry-run');
  syncPlugin({ dryRun });
}
