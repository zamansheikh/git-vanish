'use strict';

/**
 * Core git history rewriting.
 *
 * Strategy
 * ────────
 * 1. Save the current working-tree copy of the target BEFORE rewriting:
 *      • File      → read content into a Buffer (no filesystem change)
 *      • Directory → copy to os.tmpdir() (outside the repo, git doesn't see it)
 *
 * 2. Run `git rm -rf <path>` so the working tree is clean before filter-branch.
 *
 * 3. Run git filter-repo (preferred) or git filter-branch to rewrite every
 *    branch/tag and remove the file from all commits.
 *
 * 4. Expire reflogs + gc so the file is truly gone from the object store.
 *
 * 5. Restore the saved content back to its original path on disk.
 *    The file is now UNTRACKED (listed in .gitignore) — data fully preserved.
 */

const { spawnSync } = require('child_process');
const os   = require('os');
const path = require('path');
const fs   = require('fs');
const chalk = require('chalk');

/* ─── helpers ──────────────────────────────────────────────── */

function run(cmd, cwd, { silent = false, failOk = false } = {}) {
  const res = spawnSync(cmd, {
    cwd,
    shell: true,
    stdio: silent ? 'pipe' : 'inherit',
    env: {
      ...process.env,
      FILTER_BRANCH_SQUELCH_WARNING: '1',
    },
  });

  if (res.status !== 0 && !failOk) {
    const err = res.stderr ? res.stderr.toString() : '';
    throw new Error(err || `Command failed: ${cmd}`);
  }
  return res.stdout ? res.stdout.toString().trim() : '';
}

function cmdExists(name) {
  try {
    return spawnSync(name, ['--version'], { shell: true, stdio: 'pipe' }).status === 0;
  } catch { return false; }
}

/* ─── working tree backup / restore ───────────────────────── */

/**
 * Save the current on-disk content WITHOUT touching the git index or working
 * tree (so filter-branch sees a perfectly clean repo).
 *
 * File      → Content read into a Buffer in memory. Zero filesystem change.
 * Directory → Recursively copied to a temp dir OUTSIDE the repo (git never
 *             sees it). Original stays in place until filter-branch deletes it.
 *
 * After history rewriting, filter-branch's final "git checkout" removes the
 * target from the working tree. restoreSaved() then writes it back.
 *
 * Returns a descriptor { type, ... } or null if path doesn't exist on disk.
 */
function saveContent(repoPath, filePath, onProgress) {
  const fullPath = path.join(repoPath, filePath.replace(/\//g, path.sep).replace(/\/$/, ''));

  if (!fs.existsSync(fullPath)) return null;

  const stat = fs.statSync(fullPath);

  if (stat.isDirectory()) {
    const tmpDest = path.join(os.tmpdir(), `git-scrub-${Date.now()}-${path.basename(fullPath)}`);
    onProgress(chalk.gray(`  Saving directory copy → ${tmpDest}`));
    copyDirSync(fullPath, tmpDest);
    return { type: 'dir', tmp: tmpDest, dest: fullPath };
  } else {
    onProgress(chalk.gray(`  Reading file content into memory…`));
    const content = fs.readFileSync(fullPath);
    return { type: 'file', content, dest: fullPath };
  }
}

/**
 * After history rewrite, put the saved content back on disk.
 * The file lands as UNTRACKED (it's in .gitignore).
 */
function restoreSaved(saved, onProgress) {
  if (!saved) return;

  // Ensure parent exists
  const parent = path.dirname(saved.dest);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });

  if (saved.type === 'dir') {
    if (fs.existsSync(saved.dest)) {
      fs.rmSync(saved.dest, { recursive: true, force: true });
    }
    onProgress(chalk.gray(`  Restoring directory from temp…`));
    copyDirSync(saved.tmp, saved.dest);
    // Clean up temp copy
    try { fs.rmSync(saved.tmp, { recursive: true, force: true }); } catch {}

  } else {
    onProgress(chalk.gray(`  Writing file content back to disk…`));
    fs.writeFileSync(saved.dest, saved.content);
  }

  onProgress(chalk.green(`  ✔  "${path.basename(saved.dest)}" restored as untracked — data preserved.`));
}

/** Recursive directory copy (pure Node, no deps) */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

/* ─── add to .gitignore ────────────────────────────────────── */

function addToGitignore(repoPath, filePath) {
  const ignorePath = path.join(repoPath, '.gitignore');
  const gitPath    = filePath.replace(/\\/g, '/').replace(/\/$/, '');

  let existing = '';
  if (fs.existsSync(ignorePath)) {
    existing = fs.readFileSync(ignorePath, 'utf8');
    const lines   = existing.split('\n').map((l) => l.trim());
    const checked = [gitPath, gitPath + '/', '/' + gitPath, '/' + gitPath + '/'];
    if (checked.some((v) => lines.includes(v))) return false;
  }

  const newEntry = `\n# Added by git-scrub — removed from history\n${gitPath}\n`;
  fs.writeFileSync(ignorePath, existing + newEntry, 'utf8');
  return true;
}

/* ─── approach 1 – git filter-repo (preferred) ────────────── */

async function rewriteWithFilterRepo(repoPath, filePath, onProgress) {
  onProgress('Using git filter-repo (fast path)…');
  const gitPath = filePath.replace(/\\/g, '/').replace(/\/$/, '');
  run(`git filter-repo --force --path "${gitPath}" --invert-paths`, repoPath);
  onProgress('git filter-repo complete.');
}

/* ─── approach 2 – git filter-branch (universal) ──────────── */

async function rewriteWithFilterBranch(repoPath, filePath, onProgress) {
  onProgress('Using git filter-branch (universal path)…');
  onProgress(chalk.gray('  This may take a while on repos with many commits.\n'));

  const gitPath     = filePath.replace(/\\/g, '/').replace(/\/$/, '');
  const indexFilter = `git rm -r --cached --ignore-unmatch "${gitPath}"`;

  run(
    `git filter-branch --force --index-filter "${indexFilter}" --prune-empty --tag-name-filter cat -- --all`,
    repoPath
  );
  onProgress('filter-branch complete.');
}

/* ─── cleanup ──────────────────────────────────────────────── */

async function cleanup(repoPath, onProgress) {
  onProgress('Removing filter-branch backup refs…');
  // Remove all original/* refs
  const refs = run('git for-each-ref --format="%(refname)" refs/original/', repoPath, { silent: true, failOk: true });
  for (const ref of refs.split('\n').filter(Boolean)) {
    run(`git update-ref -d "${ref}"`, repoPath, { failOk: true, silent: true });
  }

  onProgress('Expiring reflogs…');
  run('git reflog expire --expire=now --all', repoPath, { failOk: true });

  onProgress('Running garbage collection…');
  run('git gc --prune=now --aggressive', repoPath, { failOk: true });
}

/* ─── main export ──────────────────────────────────────────── */

/**
 * Remove a file/directory from ALL git history while preserving the
 * current working-tree copy as an untracked file.
 *
 * @param {string}   repoPath   – absolute path to git repo root
 * @param {string}   filePath   – repo-relative path (e.g. "config/secrets.json")
 * @param {Function} onProgress – callback(message) for progress updates
 */
async function scrubFile(repoPath, filePath, onProgress = console.log) {
  // 1. Add to .gitignore FIRST (so restored copy is immediately untracked)
  const added = addToGitignore(repoPath, filePath);

  // 2. Save working-tree content WITHOUT touching the git index
  //    (working tree stays perfectly clean for filter-branch)
  const saved = saveContent(repoPath, filePath, onProgress);

  // 3. Rewrite history
  const hasFilterRepo = cmdExists('git-filter-repo');
  try {
    if (hasFilterRepo) {
      await rewriteWithFilterRepo(repoPath, filePath, onProgress);
    } else {
      await rewriteWithFilterBranch(repoPath, filePath, onProgress);
    }
  } catch (err) {
    // Rewrite failed — restore so no data is lost
    if (saved) {
      onProgress(chalk.yellow('  Rewrite failed — restoring your file/directory…'));
      restoreSaved(saved, onProgress);
    }
    throw err;
  }

  // 4. Cleanup reflogs + gc
  await cleanup(repoPath, onProgress);

  // 5. Restore working-tree copy (file is now untracked + gitignored)
  if (saved) {
    restoreSaved(saved, onProgress);
  }

  return {
    method:         hasFilterRepo ? 'filter-repo' : 'filter-branch',
    gitignoreAdded: added,
  };
}

module.exports = { scrubFile };

