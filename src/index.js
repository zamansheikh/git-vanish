'use strict';

/**
 * git-vanish — entry point.
 *
 * Two ways in, one implementation underneath.
 *
 * With no arguments you get the interactive app: a home screen, then a wizard
 * for whichever operation you pick. That is the path most people want, because
 * the hard part of history rewriting is not running the command — it is
 * knowing exactly what the command is about to do to your repository.
 *
 * With flags you get the same operations non-interactively, for scripts and
 * for people who already know what they want. Anything destructive still
 * refuses to start on a dirty working tree, still reports its scope first, and
 * still verifies the result afterwards.
 */

const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const { program } = require('commander');

const { spawnSync } = require('child_process');

const { redactSecrets } = require('./git/redact');
const {
  reassignAuthors, listAuthors, parseMapping, captureRemotes, restoreRemotes, staleOnRemote,
} = require('./git/reassign');
const { scrubFile, addToGitignore } = require('./git/rewrite');
const { findCommitsForFile } = require('./git/history');
const { createBackupBundle, restoreHint } = require('./git/backup');
const { runApp, vanishFlow, repoStats, dirtyFiles } = require('./ui/flows');

/* ─── CLI setup ──────────────────────────────────────────── */

program
  .name('git-vanish')
  // Read from package.json so --version can never drift from the published release.
  .version(require('../package.json').version)
  .argument('[mode]', 'jump straight to a screen: vanish | redact | reassign | authors')
  .description(
    'Interactively browse your repo and permanently vanish a sensitive file\n' +
    'from all git commit history — the file is preserved on disk as untracked.\n' +
    'Or redact a leaked string from every commit while keeping the file that\n' +
    'contained it, or reassign a contributor\'s commits to another identity.\n\n' +
    'Run with no arguments for the interactive app.'
  )
  .option('-r, --repo <path>',  'Path to the git repository (default: cwd)')
  .option('-f, --file <path>',  'Repo-relative file path to vanish (skip the browser)')
  .option('--no-gc',             'Skip the garbage collection step (faster, less thorough)')
  .option('--dry-run',           'Show what would happen without changing anything')
  // Consent for scripts and agents. Without a terminal there are no review
  // screens, so a rewrite only runs when the caller says so explicitly.
  .option('-y, --yes',           'Vanish --file without the confirmation screens (scripts, no terminal)')
  .option('--no-backup',         'With --yes: skip the backup bundle written before the rewrite')
  .option('--restore-remotes',   'After a non-interactive rewrite, re-add the remotes git-filter-repo removed')
  // Redaction mode — for a secret embedded in a file you need to KEEP.
  // Removing the whole file would delete real source from every commit.
  .option(
    '-s, --secret <text>',
    'Redact this literal string from all history, keeping files tracked (repeatable)',
    (val, prev) => (prev || []).concat([val])
  )
  .option(
    '--secrets-file <path>',
    'File with one secret per line to redact (safer than --secret: keeps them out of shell history)'
  )
  .option('--replacement <text>', 'Text to substitute for redacted secrets', '***REMOVED***')
  // Author reassignment — for when a person, not a file or a string, has to
  // come out of the history.
  .option(
    '--list-authors',
    'List everyone who appears in history, with commit counts, then exit'
  )
  .option(
    '--reassign <mapping>',
    'Reassign commits: "Old Name <old@mail>=New Name <new@mail>" (repeatable)',
    (val, prev) => (prev || []).concat([val])
  )
  // Co-author trailers are the third place an identity hides, and the only one
  // that can simply be deleted — a commit needs an author, but it does not need
  // a `Co-authored-by:` line.
  .option(
    '--remove-coauthor <identity>',
    'Delete this identity\'s Co-authored-by: trailers from every commit (repeatable)',
    (val, prev) => (prev || []).concat([val])
  )
  .parse(process.argv);

const opts = program.opts();
const mode = (program.args[0] || '').toLowerCase();

/* ─── helpers ────────────────────────────────────────────── */

function findRepoRoot(startPath) {
  let current = path.resolve(startPath);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** One line, not a wall — the interactive app has its own title bar. */
function banner(repoPath) {
  console.log(
    '\n' + chalk.bold.hex('#ff6b3d')('🔥 git-vanish') +
    chalk.gray(`  v${require('../package.json').version}  ·  ${repoPath}`)
  );
}

function die(message, hint) {
  console.error(chalk.red(`\n ✘  ${message}\n`));
  if (hint) console.error(chalk.gray(`    ${hint}\n`));
  process.exit(1);
}

/** Refuse to start a rewrite on top of uncommitted work. */
function requireCleanTree(repoPath) {
  if (opts.dryRun) return;
  const dirty = dirtyFiles(repoPath);
  if (dirty.length === 0) return;
  die(
    'Tracked files are modified.',
    'History rewriting replays every commit — commit or stash first.'
  );
}

function printPublishSteps(remotes, restored = []) {
  if (restored.length) {
    const list = restored.map((r) => `${r.name} → ${r.url}`).join(', ');
    console.log(chalk.green(`\n  ✓  Remote(s) restored: ${list}. Nothing has been pushed.`));
    console.log(chalk.gray('  To publish this history:\n'));
    console.log(chalk.cyan('    git push --force --all'));
    console.log(chalk.cyan('    git push --force --tags\n'));
    return;
  }
  console.log(chalk.gray('\n  git-filter-repo removes remotes so a bad rewrite cannot be pushed by accident.'));
  console.log(chalk.gray('  To publish this history (or re-run with --restore-remotes):\n'));
  if (remotes && remotes.length) {
    for (const r of remotes) console.log(chalk.cyan(`    git remote add ${r.name} ${r.url}`));
  } else {
    console.log(chalk.cyan('    git remote add origin <your-remote-url>'));
  }
  console.log(chalk.cyan('    git push --force --all'));
  console.log(chalk.cyan('    git push --force --tags\n'));
}

/* ─── non-interactive: list authors ──────────────────────── */

function runListAuthors(repoPath) {
  const people = listAuthors(repoPath);
  console.log(chalk.bold(`\n ${people.length} identit${people.length === 1 ? 'y' : 'ies'} in history:\n`));

  if (people.length === 0) {
    console.log(chalk.gray('   No commits yet.\n'));
    return;
  }

  const width = Math.max(...people.map((p) => `${p.name} <${p.email}>`.length));
  console.log(chalk.gray(
    '   ' + 'identity'.padEnd(width)
    + 'authored'.padStart(10) + 'committed'.padStart(12) + 'co-authored'.padStart(14) + 'total'.padStart(8)
  ));
  for (const p of people) {
    console.log(
      '   ' + `${p.name} <${p.email}>`.padEnd(width)
      + chalk.cyan(String(p.authored).padStart(10))
      + chalk.gray(String(p.committed).padStart(12))
      + (p.coauthored ? chalk.magenta(String(p.coauthored).padStart(14)) : chalk.gray('0'.padStart(14)))
      + chalk.white(String(p.count).padStart(8))
    );
  }

  console.log(chalk.gray(
    '\n  "committed" counts commits someone applied but did not write — rebases and squashed\n' +
    '  merges leave these behind, and a reassignment has to catch them too.'
  ));

  const trailerOnly = people.filter((p) => p.coauthored > 0 && p.authored === 0 && p.committed === 0);
  if (trailerOnly.length > 0) {
    console.log(chalk.gray(
      '\n  "co-authored" comes from ') + chalk.magenta('Co-authored-by:') + chalk.gray(' trailers in commit messages.\n' +
      '  GitHub counts these toward its contributor list, so an identity can own a slot in\n' +
      '  your sidebar without appearing on a single commit\'s author line.\n'
    ));
    // One rule per email, not per display name: matching is by email, so the
    // same command covers every name the person was credited under.
    for (const email of new Set(trailerOnly.map((p) => p.email.toLowerCase()))) {
      console.log(chalk.gray('  Remove with:    ')
        + chalk.cyan(`git-vanish --remove-coauthor "${email}"`));
    }
    console.log('');
  }

  // Identities you have already rewritten locally but not yet force-pushed
  // still sit in refs/remotes/*. Saying so is the difference between "the
  // rewrite failed" and "you have not pushed yet".
  const stale = staleOnRemote(repoPath);
  if (stale.length > 0) {
    console.log(chalk.yellow(`\n  ${stale.length} identit${stale.length === 1 ? 'y is' : 'ies are'} gone locally but still on the remote:\n`));
    for (const a of stale) {
      console.log(chalk.gray(`    ${a.name} <${a.email}>`) + chalk.gray(`  (${a.count} refs)`));
    }
    console.log(chalk.gray('\n  These live in refs/remotes/* — a cache of what the server still has.'));
    console.log(chalk.gray('  Force-push to replace it:  ') + chalk.cyan('git push --force --all\n'));
  }

  console.log(chalk.gray('  Reassign with:  ') + chalk.cyan('git-vanish --reassign "Old <old@mail>=New <new@mail>"\n'));
}

/* ─── non-interactive: reassign / remove co-author ───────── */

async function runReassign(repoPath) {
  const pairs = [];

  for (const raw of opts.reassign || []) {
    const parsed = parseMapping(raw);
    if (!parsed) {
      die(`Bad mapping: ${raw}`, 'Expected:  "Old Name <old@mail>=New Name <new@mail>"');
    }
    pairs.push(parsed);
  }
  for (const raw of opts.removeCoauthor || []) {
    pairs.push({ from: raw, to: null, remove: true });
  }

  requireCleanTree(repoPath);

  const removals = pairs.filter((p) => p.remove).length;
  const moves = pairs.length - removals;
  const what = [
    moves ? `reassigning ${moves}` : null,
    removals ? `removing ${removals} co-author` : null,
  ].filter(Boolean).join(', ');
  console.log(chalk.bold(`\n Rewriting identities (${what}):\n`));

  const result = await reassignAuthors(
    repoPath, pairs, { dryRun: opts.dryRun },
    (msg) => console.log('   ' + msg)
  );

  if (!result.changed) return;

  console.log(chalk.green(`\n  ✓  ${result.commits} commits kept, identities rewritten.\n`));
  console.log(chalk.gray(
    removals
      ? '  Files, dates and commit order are untouched. Only the identity fields and the\n' +
        '  Co-authored-by: trailers changed.'
      : '  Files, messages and dates are untouched — only the identity changed.'
  ));
  printPublishSteps(result.remotes, maybeRestoreRemotes(repoPath, result.remotes));
  console.log(chalk.gray('  Existing clones and forks keep the old identity until they re-clone.\n'));
}

/* ─── non-interactive: redact ────────────────────────────── */

async function runRedact(repoPath, secrets) {
  requireCleanTree(repoPath);

  console.log(chalk.bold(`\n Redacting ${secrets.length} secret(s) from all history:\n`));
  const remotes = captureRemotes(repoPath);

  const result = await redactSecrets(
    repoPath, secrets,
    { replacement: opts.replacement, dryRun: opts.dryRun },
    (msg) => console.log('   ' + msg)
  );

  if (!result.changed) return;

  console.log(chalk.green('\n  ✓  Secret(s) removed from every commit.\n'));
  printPublishSteps(remotes, maybeRestoreRemotes(repoPath, remotes));
  console.log(chalk.gray('  Everyone else must re-clone — their old clones still contain the secret.\n'));
}

/** --restore-remotes: put back what filter-repo removed. */
function maybeRestoreRemotes(repoPath, remotes) {
  return opts.restoreRemotes ? restoreRemotes(repoPath, remotes) : [];
}

/* ─── non-interactive: vanish ────────────────────────────── */

/**
 * The same steps as the interactive vanish wizard, for scripts and agents:
 * scope report → backup bundle → rewrite → .gitignore → verify → publish
 * steps. Runs only with --yes (or reports only, with --dry-run).
 */
async function runVanish(repoPath, files) {
  if (!opts.yes && !opts.dryRun) {
    die(
      'Vanishing rewrites every commit, so it needs consent outside the interactive app.',
      'Add --yes to run it, or --dry-run to see what it would do.'
    );
  }
  requireCleanTree(repoPath);

  const scanned = [];
  for (const file of files) scanned.push({ file, commits: await findCommitsForFile(repoPath, file) });
  const present = scanned.filter((s) => s.commits.length > 0);
  const missing = scanned.filter((s) => s.commits.length === 0);

  console.log(chalk.bold('\n Vanishing from all history:\n'));
  for (const p of present) console.log(`   ${chalk.bold(p.file)}  ${chalk.gray(`${p.commits.length} commit(s)`)}`);
  for (const m of missing) console.log(chalk.gray(`   ${m.file}  skipped: never committed`));
  if (present.length === 0) {
    console.log(chalk.gray('\n   Nothing to do — untracked files are already invisible to git.\n'));
    return;
  }

  if (opts.dryRun) {
    console.log(chalk.yellow('\n  Dry run — nothing was changed.'));
    console.log(chalk.gray('  With --yes these files would be removed from every commit, kept on disk'));
    console.log(chalk.gray('  as untracked files and added to .gitignore.\n'));
    return;
  }

  const remotes = captureRemotes(repoPath);
  let backup = null;
  if (opts.backup !== false) {
    backup = createBackupBundle(repoPath).path;
    console.log(chalk.gray(`\n   Backup: ${backup}\n`));
  }

  const done = [];
  for (const [i, p] of present.entries()) {
    try {
      const gc = opts.gc !== false && i === present.length - 1; // gc once, at the end
      await scrubFile(repoPath, p.file, (msg) => console.log('   ' + msg), { gc });
      done.push(p.file);
    } catch (err) {
      console.error(chalk.red(`\n ✘  Failed on "${p.file}": ${err.message}\n`));
      if (backup) console.error(chalk.gray(`    Restore with:  ${restoreHint(backup)}\n`));
      process.exitCode = 1;
      break;
    }
  }
  if (done.length === 0) return;

  let added = 0;
  for (const file of done) if (addToGitignore(repoPath, file)) added++;
  if (added) {
    spawnSync('git', ['add', '.gitignore'], { cwd: repoPath, stdio: 'pipe' });
    spawnSync('git', ['commit', '-m', 'chore: ignore files removed from history [git-vanish]'],
      { cwd: repoPath, stdio: 'pipe' });
  }

  // Verify: a rewrite that "succeeded" but left the file behind must not pass.
  const leftover = [];
  for (const file of done) if ((await findCommitsForFile(repoPath, file)).length) leftover.push(file);
  if (leftover.length) {
    die(`Still in history after the rewrite: ${leftover.join(', ')}`,
      backup ? `Restore with:  ${restoreHint(backup)}` : undefined);
  }

  console.log(chalk.green(`\n  ✓  ${done.length} file(s) vanished from all git history.`));
  console.log(chalk.gray('  Your copies are still on disk, now untracked' +
    (added ? `; ${added} .gitignore entr${added === 1 ? 'y' : 'ies'} committed.` : '.')));
  printPublishSteps(remotes, maybeRestoreRemotes(repoPath, remotes));
  console.log(chalk.gray('  Collaborators must re-clone. Rotate any leaked credentials — hosts may have cached the old content.\n'));
  if (backup) console.log(chalk.gray(`  Undo everything with:  ${restoreHint(backup)}\n`));
}

/* ─── main ───────────────────────────────────────────────── */

async function main() {
  const startDir = opts.repo ? path.resolve(opts.repo) : process.cwd();
  const repoPath = findRepoRoot(startDir);

  if (!repoPath) {
    die(
      `No git repository found at or above: ${startDir}`,
      'Run this command from inside a git repository, or use --repo <path>.'
    );
  }

  // ── Non-interactive paths, in the order they short-circuit ──

  if (opts.listAuthors) { banner(repoPath); return runListAuthors(repoPath); }
  if ((opts.reassign && opts.reassign.length > 0) ||
      (opts.removeCoauthor && opts.removeCoauthor.length > 0)) {
    banner(repoPath);
    return runReassign(repoPath);
  }

  const secrets = [
    ...(opts.secret || []),
    ...(opts.secretsFile
      ? fs.readFileSync(path.resolve(opts.secretsFile), 'utf8')
          .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      : []),
  ];
  if (secrets.length > 0) { banner(repoPath); return runRedact(repoPath, secrets); }

  const hasTerminal = process.stdin.isTTY && process.stdout.isTTY;
  const files = opts.file
    ? opts.file.split(',').map((f) => f.trim().replace(/\\/g, '/')).filter(Boolean)
    : null;

  // Vanish without the wizard: explicit --yes (or --dry-run), or no terminal.
  if (files && (opts.yes || opts.dryRun || !hasTerminal)) {
    banner(repoPath);
    return runVanish(repoPath, files);
  }

  // ── Interactive from here on ──

  if (!hasTerminal) {
    die(
      'The interactive app needs a terminal.',
      'Without one, use flags: --file <path> --yes (vanish), --secret (redact), ' +
      '--reassign or --list-authors. See: git-vanish --help'
    );
  }

  const ctx = {
    repoPath,
    repoName: path.basename(repoPath),
    dryRun: !!opts.dryRun,
    gc: opts.gc !== false,
    stats: repoStats(repoPath),
  };

  // --file preselects the browser's result but keeps every review and
  // confirmation screen: skipping the picker is not consent to a rewrite.
  if (opts.file) {
    const { Ui } = require('./ui/ui');
    const ui = new Ui();
    ui.open();
    try {
      await vanishFlow(ui, ctx, files);
    } finally {
      ui.close();
    }
    return;
  }

  if (mode) {
    const known = { vanish: 1, redact: 1, reassign: 1, authors: 1, contributors: 1 };
    if (!known[mode]) {
      die(`Unknown mode: ${mode}`, 'Expected one of: vanish, redact, reassign, authors');
    }
    ctx.startAt = mode === 'contributors' ? 'authors' : mode;
  }

  await runApp(ctx);
}

main().catch((err) => {
  // The TUI restores the terminal from its own exit hook; this is the last
  // line of defence for anything that escapes it.
  process.stdout.write('\x1b[?25h\x1b[?1000l\x1b[?1006l');
  console.error(chalk.red('\n ✘  ' + (err && err.message ? err.message : String(err)) + '\n'));
  process.exit(1);
});
