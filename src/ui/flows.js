'use strict';

/**
 * The interactive application: a home screen and one wizard per operation.
 *
 * Two rules shape everything here.
 *
 * The first is that nothing irreversible happens without a screen that states
 * exactly what is about to change, in the user's own repository's terms — this
 * many commits, these identities, this file — followed by a dialog whose
 * default is Cancel.
 *
 * The second is that the rewrite itself runs OUTSIDE the TUI. We drop back to
 * the normal terminal before touching history so the output lands in the
 * scrollback the user can still read tomorrow, next to the commands they need
 * to run next. A full-screen app that swallows the record of what it did to
 * your git history would be a worse tool, however nice it looked.
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const chalk = require('chalk');

const { Ui } = require('./ui');
const { theme, G, fit } = require('./tui');
const FileBrowser = require('./browser');

const { getAllTrackedFiles, findCommitsForFile } = require('../git/history');
const { scrubFile, addToGitignore } = require('../git/rewrite');
const { redactSecrets, maskSecret, countOccurrences } = require('../git/redact');
const {
  reassignAuthors, listAuthors, previewReassign, captureRemotes, hasFilterRepo,
  identityRoles,
} = require('../git/reassign');
const { createBackupBundle, restoreHint } = require('../git/backup');
const { confirm } = require('./confirm');

/* ─── shared helpers ─────────────────────────────────────── */

function git(repoPath, args) {
  const res = spawnSync('git', args, { cwd: repoPath, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
  return res.status === 0 ? res.stdout.toString().trim() : '';
}

/** Modified tracked files — the thing that makes a rewrite unsafe to start. */
function dirtyFiles(repoPath) {
  const out = git(repoPath, ['status', '--porcelain', '--untracked-files=no']);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** "1 commit" / "2 commits" — a dashboard that says "1 commits" reads as a bug. */
function plural(n, one, many) {
  const count = Number(n);
  return `${n} ${count === 1 ? one : many || one + 's'}`;
}

function repoStats(repoPath) {
  const commits = git(repoPath, ['rev-list', '--all', '--count']) || '0';
  const branches = git(repoPath, ['branch', '--list']).split('\n').filter(Boolean).length;
  const tracked = git(repoPath, ['ls-files']).split('\n').filter(Boolean).length;
  let people = 0;
  try { people = listAuthors(repoPath).length; } catch { /* not a repo yet */ }
  return { commits, branches, tracked, people };
}

/** A banner every destructive review screen ends with. */
function rewriteWarnings() {
  return [
    theme.warn('•') + ' Every commit hash after the earliest change is rewritten.',
    theme.warn('•') + ' You must force-push, and collaborators must re-clone.',
    theme.warn('•') + ' Existing clones, forks and host caches keep the old data.',
    theme.danger('•') + ' This cannot be undone without a backup.',
  ];
}

/**
 * Confirm a destructive action, offering a backup bundle first.
 * @returns {Promise<{go: boolean, backup?: string}>}
 */
async function confirmDestructive(ui, { title, crumb, lines, confirmLabel, repoPath }) {
  const choice = await ui.menu({
    title: 'Take a backup first?',
    crumb,
    right: path.basename(repoPath),
    items: [
      {
        icon: '🛟', label: 'Yes — bundle the whole repo first  (recommended)',
        hint: 'one file, restores everything', value: 'backup',
      },
      { icon: '⚡', label: 'No — I already have a backup', hint: 'skip', value: 'skip' },
      { icon: '↩', label: 'Cancel', value: null },
    ],
    note: theme.dim('  A bundle is written next to the repo folder and can be cloned back at any time.'),
  });

  if (!choice) return { go: false };

  let backup = null;
  if (choice === 'backup') {
    try {
      backup = createBackupBundle(repoPath).path;
    } catch (err) {
      const proceed = await ui.dialog({
        title: 'Backup failed',
        crumb,
        danger: true,
        lines: [
          theme.danger('Could not write the backup bundle:'),
          '',
          ...String(err.message).split('\n').slice(0, 4).map((l) => '  ' + l),
          '',
          'You can continue without one, but the rewrite will not be undoable.',
        ],
        confirmLabel: 'Continue anyway',
      });
      if (!proceed) return { go: false };
    }
  }

  const go = await ui.dialog({
    title,
    crumb,
    danger: true,
    lines: [
      ...lines,
      '',
      ...rewriteWarnings(),
      '',
      backup
        ? theme.ok(`${G.check} Backup saved: ${path.basename(backup)}`)
        : theme.dim('No backup was taken.'),
    ],
    confirmLabel: confirmLabel || 'Rewrite history',
    cancelLabel: 'Cancel',
  });

  return { go, backup };
}

/** Print the "your remote is gone, here is how to publish" block. */
function printPublishSteps(remotes) {
  console.log(chalk.gray('\n  git-filter-repo removes remotes so a bad rewrite cannot be pushed by accident.'));
  console.log(chalk.gray('  To publish this history:\n'));
  if (remotes && remotes.length) {
    for (const r of remotes) {
      console.log(chalk.cyan(`    git remote add ${r.name} ${r.url}`));
    }
  } else {
    console.log(chalk.cyan('    git remote add origin <your-remote-url>'));
  }
  console.log(chalk.cyan('    git push --force --all'));
  console.log(chalk.cyan('    git push --force --tags\n'));
}

/** Offer to put the remotes back, since we know exactly what they were. */
async function offerRemoteRestore(repoPath, remotes) {
  if (!remotes || remotes.length === 0) return;
  if (git(repoPath, ['remote'])) return;   // filter-repo left them alone

  const list = remotes.map((r) => `${r.name} → ${r.url}`).join(', ');
  const yes = await confirm(`Re-add the remote(s) now?  (${list})`);
  if (!yes) return;

  for (const r of remotes) {
    spawnSync('git', ['remote', 'add', r.name, r.url], { cwd: repoPath, stdio: 'pipe' });
  }
  console.log(chalk.green(`\n  ${G.check}  Remote(s) restored. Nothing has been pushed.\n`));
}

/* ─── blockers ───────────────────────────────────────────── */

async function blockIfDirty(ui, ctx, crumb) {
  const dirty = dirtyFiles(ctx.repoPath);
  if (dirty.length === 0) return false;

  await ui.page({
    title: 'Working tree has uncommitted changes',
    crumb,
    right: ctx.repoName,
    lines: [
      theme.danger('Rewriting history replays every commit, so the working tree must be clean.'),
      '',
      theme.label('Modified tracked files:'),
      ...dirty.slice(0, 20).map((l) => '  ' + theme.dim(l)),
      ...(dirty.length > 20 ? ['  ' + theme.dim(`… and ${dirty.length - 20} more`)] : []),
      '',
      theme.label('Fix it with either:'),
      '  ' + theme.accent('git stash') + theme.dim('    park the changes, restore them afterwards'),
      '  ' + theme.accent('git commit -am "wip"') + theme.dim('   keep them in history'),
    ],
    buttonLabel: 'Back',
  });
  return true;
}

async function blockIfNoFilterRepo(ui, ctx, crumb, what) {
  if (hasFilterRepo()) return false;
  await ui.page({
    title: 'git-filter-repo is required',
    crumb,
    right: ctx.repoName,
    lines: [
      `${what} needs git-filter-repo, which is not installed.`,
      '',
      theme.label('Install it with one of:'),
      '  ' + theme.accent('brew install git-filter-repo'),
      '  ' + theme.accent('pip install git-filter-repo'),
      '  ' + theme.accent('apt install git-filter-repo'),
      '',
      theme.dim('It is the tool the git project itself recommends for history rewriting.'),
    ],
    buttonLabel: 'Back',
  });
  return true;
}

/* ─── flow: reassign a contributor ───────────────────────── */

const CRUMB_REASSIGN = 'Reassign contributor';

/** Sentinel target: delete the identity rather than move it to someone. */
const REMOVE = Symbol('remove');

/**
 * "9 authored · 5 committed · 7 co-authored" — where an identity actually
 * appears. The breakdown matters because the three roles are fixed by
 * different mechanisms, and a co-author trailer is the one people never
 * expect to find.
 */
function roleSummary(r) {
  const parts = [
    r.authored ? `${r.authored} authored` : null,
    r.committed ? `${r.committed} committed` : null,
    r.coauthored ? `${r.coauthored} co-authored` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'not in history';
}

async function reassignFlow(ui, ctx) {
  if (await blockIfNoFilterRepo(ui, ctx, CRUMB_REASSIGN, 'Reassigning authorship')) return false;
  if (await blockIfDirty(ui, ctx, CRUMB_REASSIGN)) return false;

  let people;
  try {
    people = listAuthors(ctx.repoPath);
  } catch (err) {
    await ui.page({
      title: 'Could not read history', crumb: CRUMB_REASSIGN,
      lines: [theme.danger(err.message)], buttonLabel: 'Back',
    });
    return false;
  }

  if (people.length === 0) {
    await ui.page({
      title: 'No commits yet', crumb: CRUMB_REASSIGN, right: ctx.repoName,
      lines: [theme.dim('This repository has no history to reassign.')],
      buttonLabel: 'Back',
    });
    return false;
  }

  const anyCoauthors = people.some((p) => p.coauthored > 0);

  // ── 1. Who is moving? ──
  const sources = await ui.checklist({
    title: 'Whose commits are moving?',
    crumb: CRUMB_REASSIGN,
    right: ctx.repoName,
    items: people.map((p) => ({
      label: `${p.name || '(no name)'} <${p.email}>`,
      hint: roleSummary(p),
      value: p,
    })),
    note: theme.dim('  Matching is by email, so every display name this person used is included.\n')
      + theme.dim('  Tick several to merge them all onto one identity.')
      + (anyCoauthors
        ? '\n' + theme.warn('  co-authored')
          + theme.dim(' = a Co-authored-by: trailer in the message. GitHub counts these\n')
          + theme.dim('  as contributors even when the person authored nothing.')
        : ''),
  });
  if (!sources || sources.length === 0) return false;

  // Two source rows can share an email (same person, different display names);
  // one rule covers both, so collapse them before building mappings.
  const uniqueEmails = [...new Map(sources.map((s) => [s.email.toLowerCase(), s])).values()];

  // Someone who only ever appears in a trailer can simply be deleted. Someone
  // who authored or committed cannot — every commit needs an author — so the
  // "remove" option is offered only when it is actually possible.
  const roles = uniqueEmails.map((s) => identityRoles(ctx.repoPath, s.email));
  const removable = roles.every((r) => r.coauthored > 0 && r.authored === 0 && r.committed === 0);

  // ── 2. Where do they go? ──
  const target = await pickTarget(ui, ctx, people, uniqueEmails, removable);
  if (!target) return false;

  // ── 3. Review ──
  const removing = target === REMOVE;
  const pairs = uniqueEmails.map((s) => ({
    from: `${s.name} <${s.email}>`,
    to: removing ? null : `${target.name} <${target.email}>`,
    remove: removing,
  }));

  let preview;
  try {
    preview = previewReassign(ctx.repoPath, pairs);
  } catch (err) {
    await ui.page({
      title: 'That mapping will not work', crumb: CRUMB_REASSIGN,
      lines: [theme.danger(err.message)], buttonLabel: 'Back',
    });
    return false;
  }

  const totalRefs = preview.reduce((n, m) => n + m.refs, 0);
  if (totalRefs === 0) {
    await ui.page({
      title: 'Nothing to do', crumb: CRUMB_REASSIGN, right: ctx.repoName,
      lines: [theme.dim('None of those identities appear in history any more.')],
      buttonLabel: 'Back',
    });
    return false;
  }

  const renameOnly = !removing
    && preview.every((m) => m.from.email.toLowerCase() === m.to.email.toLowerCase());
  const touchesTrailers = preview.some((m) => m.roles.coauthored > 0);
  const touchesFields = preview.some((m) => m.roles.authored + m.roles.committed > 0);

  // The one screen that must never abbreviate: an elided character in the
  // email you are about to erase is exactly the typo you would not catch.
  // Side by side when both identities fit, stacked when they do not.
  const label = (id) => `${id.name || '(no name)'} <${id.email}>`;

  // Several ticked rows can share one email — the same person under different
  // display names. They collapse into a single rule, so the review has to name
  // every display name that rule will catch rather than whichever row happened
  // to survive the collapse.
  const namesFor = (email) => sources
    .filter((s) => s.email.toLowerCase() === email.toLowerCase())
    .map((s) => s.name || '(no name)');
  const fromLabel = (m) => {
    const names = namesFor(m.from.email);
    return names.length > 1 ? `<${m.from.email}>` : label(m.from);
  };

  const widest = Math.max(...preview.flatMap((m) =>
    [fromLabel(m).length, removing ? 9 : label(m.to).length]));
  const sideBySide = widest * 2 + 16 <= ui.width;
  const rhs = (m) => (removing ? theme.dim('(removed)') : theme.ok(label(m.to)));

  const mappingLines = preview.flatMap((m) => {
    const names = namesFor(m.from.email);
    const covering = names.length > 1
      ? ['    ' + theme.dim(`covering ${names.length} display names: ${names.join(', ')}`)]
      : [];

    return sideBySide
      ? ['  ' + theme.danger(fit(fromLabel(m), widest))
         + theme.accent(' → ')
         + (removing ? theme.dim(fit('(removed)', widest)) : theme.ok(fit(label(m.to), widest)))
         + theme.dim(`  ${roleSummary(m.roles)}`),
         ...covering]
      : [
          '  ' + theme.danger(fromLabel(m)) + theme.dim(`   ${roleSummary(m.roles)}`),
          ...covering,
          '    ' + theme.accent('→ ') + rhs(m),
          '',
        ];
  });

  const changes = [
    touchesFields ? 'author, committer and tagger fields' : null,
    touchesTrailers ? 'Co-authored-by: trailers in commit messages' : null,
  ].filter(Boolean).join(' + ');

  const ok = await ui.page({
    title: removing ? 'Review the removal' : 'Review the reassignment',
    crumb: CRUMB_REASSIGN,
    right: ctx.repoName,
    lines: [
      theme.label(removing
        ? 'These identities will be dropped from every commit message:'
        : 'These identities will be rewritten across all branches and tags:'),
      '',
      ...mappingLines,
      '',
      theme.label('What changes:  ') + changes,
      theme.label('What does not: ') + (touchesTrailers
        ? 'files, dates, commit order, the rest of every message'
        : 'files, messages, dates, commit order'),
      '',
      removing
        ? theme.dim('The trailer line is deleted outright — nothing else in the message moves,')
        : renameOnly
          ? theme.dim('The email is unchanged — this is a display-name correction.')
          : theme.dim('The old email disappears from this copy of the history entirely.'),
      ...(removing
        ? [theme.dim('and GitHub stops counting this identity as a contributor.')]
        : []),
      '',
      theme.dim(`${totalRefs} reference(s) across ${ctx.stats.commits} commits will be touched.`),
    ],
    buttonLabel: 'Continue',
  });
  if (!ok) return false;

  // ── 4. Confirm and run ──
  const { go, backup } = await confirmDestructive(ui, {
    title: removing ? 'Remove these co-authors?' : 'Rewrite authorship?',
    crumb: CRUMB_REASSIGN,
    repoPath: ctx.repoPath,
    confirmLabel: removing ? 'Remove' : 'Reassign',
    lines: [
      chalk.bold.white(
        removing
          ? `Drop ${totalRefs} co-author trailer(s) from ${ctx.repoName}`
          : `Reassign ${totalRefs} reference(s) in ${ctx.repoName}`
      ),
      '',
      ...preview.map((m) => '  ' + theme.danger(m.from.email) + ' → '
        + (removing ? theme.dim('removed') : theme.ok(`${m.to.name} <${m.to.email}>`))),
    ],
  });
  if (!go) return false;

  await ui.suspend(async () => {
    console.log(chalk.bold(
      removing
        ? `\n Removing ${preview.length} co-author identit${preview.length === 1 ? 'y' : 'ies'}:\n`
        : `\n Reassigning ${preview.length} identit${preview.length === 1 ? 'y' : 'ies'}:\n`
    ));
    if (backup) console.log(chalk.gray(`   Backup: ${backup}\n`));

    let result;
    try {
      result = await reassignAuthors(ctx.repoPath, pairs, {}, (msg) => console.log('   ' + msg));
    } catch (err) {
      console.error('\n' + chalk.red(' ✘  ' + err.message) + '\n');
      if (backup) console.error(chalk.gray(`    Restore with:  ${restoreHint(backup)}\n`));
      process.exitCode = 1;
      return;
    }

    if (!result.changed) return;

    console.log(chalk.green(
      removing
        ? `\n  ${G.check}  ${result.commits} commits kept, co-author trailers removed.\n`
        : `\n  ${G.check}  ${result.commits} commits kept, authorship moved.\n`
    ));
    console.log(chalk.gray(
      touchesTrailers
        ? '  Files, dates and commit order are untouched. Only identity fields and the\n' +
          '  Co-authored-by: trailers changed.'
        : '  Files, messages and dates are untouched — only the identity changed.'
    ));
    printPublishSteps(result.remotes);
    await offerRemoteRestore(ctx.repoPath, result.remotes);
    console.log(chalk.gray(
      '  Existing clones and forks keep the old identity until they re-clone.\n'
    ));
    if (touchesTrailers) {
      console.log(chalk.gray(
        '  GitHub recalculates its contributor list from the pushed commits, so the\n' +
        '  sidebar updates once the force-push lands.\n'
      ));
    }
    if (backup) console.log(chalk.gray(`  Undo everything with:  ${restoreHint(backup)}\n`));
  });

  return true;
}

/**
 * Choose the identity the commits move TO — or the sentinel meaning
 * "delete them", which is a different operation with the same starting point.
 */
async function pickTarget(ui, ctx, people, sources, removable) {
  const sourceEmails = new Set(sources.map((s) => s.email.toLowerCase()));
  const others = people.filter((p) => !sourceEmails.has(p.email.toLowerCase()));
  const first = sources[0];

  const how = await ui.menu({
    title: 'Who should these commits belong to?',
    crumb: CRUMB_REASSIGN,
    right: ctx.repoName,
    items: [
      // Listed first when it applies: someone who only appears in a trailer is
      // almost always someone you want gone, not someone you want renamed.
      ...(removable ? [{
        icon: '🧹', label: 'Nobody — remove them from the commits',
        hint: 'deletes the Co-authored-by: line', value: REMOVE,
      }] : []),
      { icon: '✍', label: 'Type a new identity', hint: 'name + email', value: 'new' },
      {
        icon: '👥', label: 'An existing contributor', hint: `${others.length} available`,
        value: 'existing', disabled: others.length === 0,
      },
      {
        icon: '🕶', label: 'Anonymise', hint: 'GitHub noreply address', value: 'anon',
      },
      { icon: '↩', label: 'Back', value: null },
    ],
    note: removable
      ? theme.dim('  These identities appear only in Co-authored-by: trailers, so they can be\n')
        + theme.dim('  deleted outright — a trailer is optional, an author field is not.')
      : theme.dim('  Moving to an existing contributor merges the two identities into one.'),
  });

  if (!how) return null;
  if (how === REMOVE) return REMOVE;

  if (how === 'existing') {
    return ui.menu({
      title: 'Reassign to which contributor?',
      crumb: CRUMB_REASSIGN,
      right: ctx.repoName,
      items: [
        ...others.map((p) => ({
          icon: '👤', label: `${p.name} <${p.email}>`, hint: `${p.count} refs`, value: p,
        })),
        { icon: '↩', label: 'Back', value: null },
      ],
    });
  }

  const preset = how === 'anon'
    ? { name: 'Anonymous', email: 'anonymous@users.noreply.github.com' }
    : { name: first.name || '', email: '' };

  const values = await ui.form({
    title: how === 'anon' ? 'Anonymised identity' : 'New identity',
    crumb: CRUMB_REASSIGN,
    right: ctx.repoName,
    intro: [
      theme.dim(`Replacing: `) + theme.danger(`${first.name} <${first.email}>`)
        + (sources.length > 1 ? theme.dim(`  and ${sources.length - 1} more`) : ''),
    ],
    submitLabel: 'Review',
    fields: [
      {
        name: 'name', label: 'Display name', value: preset.name,
        placeholder: 'e.g. Jane Doe',
        validate: (v) => (v ? null : 'A display name is required.'),
      },
      {
        name: 'email', label: 'Email address', value: preset.email,
        placeholder: 'e.g. jane@example.com',
        hint: 'used to match and to attribute',
        validate: (v) => {
          if (!v) return 'An email address is required.';
          if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(v)) return 'That does not look like an email address.';
          return null;
        },
      },
    ],
  });

  return values ? { name: values.name, email: values.email } : null;
}

/* ─── flow: list contributors ────────────────────────────── */

async function contributorsFlow(ui, ctx) {
  let people;
  try { people = listAuthors(ctx.repoPath); }
  catch (err) {
    await ui.page({ title: 'Could not read history', lines: [theme.danger(err.message)], buttonLabel: 'Back' });
    return false;
  }

  // The numbers are the point of this screen, so the identity column yields to
  // them: a long noreply address gets elided rather than pushing the counts off
  // the right edge.
  const NUMERIC = 10 + 12 + 14 + 8;
  const longest = Math.max(10, ...people.map((p) => `${p.name} <${p.email}>`.length));
  const width = Math.max(20, Math.min(longest, ui.width - NUMERIC - 5));

  await ui.page({
    title: `${people.length} identit${people.length === 1 ? 'y' : 'ies'} in history`,
    crumb: 'Contributors',
    right: ctx.repoName,
    lines: people.length === 0
      ? [theme.dim('No commits yet.')]
      : [
          // The co-authored column belongs here as much as in --list-authors:
          // without it, someone who only appears in trailers reads as "0, 0,
          // total 1", which looks like a bug in the tool rather than the one
          // fact on this screen the reader most needs.
          theme.dim(fit('  identity', width + 4) + fit('authored', 10, 'right')
            + fit('committed', 12, 'right') + fit('co-authored', 14, 'right')
            + fit('total', 8, 'right')),
          '',
          ...people.map((p) =>
            '  ' + chalk.white(fit(`${p.name} <${p.email}>`, width))
            + theme.accent(String(p.authored).padStart(10))
            + theme.dim(String(p.committed).padStart(12))
            + (p.coauthored
              ? theme.warn(String(p.coauthored).padStart(14))
              : theme.dim('0'.padStart(14)))
            + chalk.white(String(p.count).padStart(8))),
          '',
          theme.dim('  "committed" counts commits someone applied but did not write — rebases and'),
          theme.dim('  squashed merges leave these behind, and a reassignment must catch them too.'),
          ...(people.some((p) => p.coauthored > 0)
            ? [
                '',
                theme.dim('  "co-authored" comes from ') + theme.warn('Co-authored-by:')
                  + theme.dim(' trailers in the commit message.'),
                theme.dim('  GitHub counts these as contributors even when the person authored nothing.'),
              ]
            : []),
        ],
    buttonLabel: 'Back',
  });
  return false;
}

/* ─── flow: redact a secret ──────────────────────────────── */

const CRUMB_REDACT = 'Redact a secret';

async function redactFlow(ui, ctx) {
  if (await blockIfNoFilterRepo(ui, ctx, CRUMB_REDACT, 'Redacting secrets')) return false;
  if (await blockIfDirty(ui, ctx, CRUMB_REDACT)) return false;

  const values = await ui.form({
    title: 'Which string should disappear?',
    crumb: CRUMB_REDACT,
    right: ctx.repoName,
    intro: [
      theme.dim('Every occurrence in every commit is replaced. The files stay tracked —'),
      theme.dim('use this when the secret is inside source you need to keep.'),
    ],
    submitLabel: 'Scan history',
    fields: [
      {
        name: 'secret', label: 'Secret (typed exactly as it appears)',
        placeholder: 'ghp_xxxxxxxxxxxxxxxxxxxx',
        validate: (v) => {
          if (!v) return 'Enter the string to redact.';
          if (v.length < 4) return 'Too short to redact safely — it would match ordinary text.';
          return null;
        },
      },
      {
        name: 'replacement', label: 'Replace it with', value: '***REMOVED***',
        hint: 'appears in history instead',
        validate: (v) => (v ? null : 'Enter replacement text.'),
      },
    ],
  });
  if (!values) return false;

  const hits = countOccurrences(ctx.repoPath, values.secret);
  if (hits === 0) {
    await ui.page({
      title: 'Not found in history', crumb: CRUMB_REDACT, right: ctx.repoName,
      lines: [
        theme.ok(`${G.check} "${maskSecret(values.secret)}" does not appear in any commit.`),
        '',
        theme.dim('Nothing to redact. Note this matches exact bytes — check for'),
        theme.dim('different quoting or whitespace if you expected a hit.'),
      ],
      buttonLabel: 'Back',
    });
    return false;
  }

  const { go, backup } = await confirmDestructive(ui, {
    title: 'Redact this secret?',
    crumb: CRUMB_REDACT,
    repoPath: ctx.repoPath,
    confirmLabel: 'Redact',
    lines: [
      chalk.bold.white(`Redact "${maskSecret(values.secret)}" from ${ctx.repoName}`),
      '',
      theme.label('Introduced or removed by: ') + chalk.bold.yellow(`${hits} commit(s)`),
      theme.label('Replaced with:            ') + chalk.white(values.replacement),
      '',
      theme.warn('Rotate this credential regardless — it has already been exposed.'),
    ],
  });
  if (!go) return false;

  await ui.suspend(async () => {
    console.log(chalk.bold('\n Redacting from all history:\n'));
    if (backup) console.log(chalk.gray(`   Backup: ${backup}\n`));

    const remotes = captureRemotes(ctx.repoPath);
    try {
      const result = await redactSecrets(
        ctx.repoPath, [values.secret],
        { replacement: values.replacement },
        (msg) => console.log('   ' + msg),
      );
      if (!result.changed) return;
    } catch (err) {
      console.error('\n' + chalk.red(' ✘  ' + err.message) + '\n');
      if (backup) console.error(chalk.gray(`    Restore with:  ${restoreHint(backup)}\n`));
      process.exitCode = 1;
      return;
    }

    console.log(chalk.green(`\n  ${G.check}  Secret removed from every commit.\n`));
    printPublishSteps(remotes);
    await offerRemoteRestore(ctx.repoPath, remotes);
    console.log(chalk.gray('  Everyone else must re-clone — their old clones still contain the secret.\n'));
    if (backup) console.log(chalk.gray(`  Undo everything with:  ${restoreHint(backup)}\n`));
  });

  return true;
}

/* ─── flow: vanish files ─────────────────────────────────── */

const CRUMB_VANISH = 'Vanish files';

async function vanishFlow(ui, ctx, preselected) {
  if (await blockIfDirty(ui, ctx, CRUMB_VANISH)) return false;

  let files = preselected;

  if (!files) {
    let tracked = null;
    try { tracked = await getAllTrackedFiles(ctx.repoPath); } catch { /* browse unfiltered */ }

    const browser = new FileBrowser({
      root: ctx.repoPath,
      gitFiles: tracked,
      title: 'Select file(s) to vanish from history',
      crumb: CRUMB_VANISH,
    });
    files = await ui.custom(browser);
    if (!files || files.length === 0) return false;
  }

  // Scan each selection so the review screen talks about real commits.
  const scanned = [];
  for (const file of files) {
    const commits = await findCommitsForFile(ctx.repoPath, file);
    scanned.push({ file, commits });
  }

  const present = scanned.filter((s) => s.commits.length > 0);
  const missing = scanned.filter((s) => s.commits.length === 0);

  if (present.length === 0) {
    await ui.page({
      title: 'Nothing found in history', crumb: CRUMB_VANISH, right: ctx.repoName,
      lines: [
        theme.dim('None of the selected paths appear in any commit:'),
        '',
        ...missing.map((m) => '  ' + theme.dim(m.file)),
        '',
        theme.dim('Untracked files are already invisible to git — there is nothing to remove.'),
      ],
      buttonLabel: 'Back',
    });
    return false;
  }

  const lines = [];
  for (const { file, commits } of present) {
    lines.push(chalk.bold.white('  ' + file) + theme.dim(`   ${commits.length} commit(s)`));
    for (const c of commits.slice(0, 6)) {
      lines.push('    ' + theme.accent(c.hash.slice(0, 8)) + theme.dim('  ' + c.date + '  ')
        + fit(c.message, Math.max(20, ui.width - 30)));
    }
    if (commits.length > 6) lines.push('    ' + theme.dim(`… and ${commits.length - 6} more`));
    lines.push('');
  }
  if (missing.length) {
    lines.push(theme.dim('  Skipped (never committed): ' + missing.map((m) => m.file).join(', ')));
    lines.push('');
  }

  const ok = await ui.page({
    title: `${present.length} file(s) will be removed from history`,
    crumb: CRUMB_VANISH,
    right: ctx.repoName,
    lines: [
      theme.dim('  Your working copy is preserved on disk as an untracked file.'),
      '',
      ...lines,
    ],
    buttonLabel: 'Continue',
  });
  if (!ok) return false;

  if (ctx.dryRun) {
    await ui.page({
      title: 'Dry run — nothing was changed', crumb: CRUMB_VANISH, right: ctx.repoName,
      lines: present.map((p) => '  ' + theme.accent(p.file) + theme.dim(`  → ${p.commits.length} commit(s)`)),
      buttonLabel: 'Back',
    });
    return false;
  }

  const totalCommits = present.reduce((n, p) => n + p.commits.length, 0);
  const { go, backup } = await confirmDestructive(ui, {
    title: 'Vanish these files?',
    crumb: CRUMB_VANISH,
    repoPath: ctx.repoPath,
    confirmLabel: 'Vanish',
    lines: [
      chalk.bold.white(`Remove ${present.length} file(s) from ${totalCommits} commit(s) in ${ctx.repoName}`),
      '',
      ...present.map((p) => '  ' + theme.danger(p.file) + theme.dim(`  ${p.commits.length} commit(s)`)),
      '',
      theme.ok('Your on-disk copy is kept — the file becomes untracked.'),
    ],
  });
  if (!go) return false;

  const addIgnore = await ui.dialog({
    title: 'Add them to .gitignore?',
    crumb: CRUMB_VANISH,
    lines: [
      'Once vanished, nothing stops the file being committed again tomorrow.',
      '',
      ...present.map((p) => '  ' + theme.accent(p.file)),
      '',
      theme.dim('The .gitignore change is committed as a normal commit afterwards.'),
    ],
    confirmLabel: 'Yes, ignore them',
    cancelLabel: 'No',
  });

  await ui.suspend(async () => {
    const ora = require('ora');
    // filter-repo removes remotes; remember them so they can be put back.
    const remotes = captureRemotes(ctx.repoPath);
    const done = [];

    console.log('');
    if (backup) console.log(chalk.gray(` Backup: ${backup}\n`));

    for (const [i, { file }] of present.entries()) {
      const spinner = ora({ text: `Rewriting history for ${file}…`, color: 'red' }).start();
      try {
        // Garbage-collect once, after the last file (and never with --no-gc).
        const gc = ctx.gc !== false && i === present.length - 1;
        const result = await scrubFile(ctx.repoPath, file, (msg) => { spinner.text = chalk.gray(msg); }, { gc });
        spinner.succeed(chalk.green(`Vanished "${file}"  ${chalk.gray('[' + result.method + ']')}`));
        done.push(file);
      } catch (err) {
        spinner.fail(chalk.red(`Failed on "${file}"`));
        console.error('\n' + chalk.red(err.message) + '\n');
        process.exitCode = 1;
      }
    }

    if (done.length === 0) {
      if (backup) console.log(chalk.gray(`\n  Restore with:  ${restoreHint(backup)}\n`));
      return;
    }

    if (addIgnore) {
      let added = 0;
      for (const file of done) if (addToGitignore(ctx.repoPath, file)) added++;
      spawnSync('git', ['add', '.gitignore'], { cwd: ctx.repoPath, stdio: 'pipe' });
      spawnSync('git', ['commit', '-m', 'chore: ignore files removed from history [git-vanish]'],
        { cwd: ctx.repoPath, stdio: 'pipe' });
      console.log(chalk.green(`\n  ${G.check}  ${added} entry/entries added to .gitignore and committed.`));
    }

    console.log(chalk.green(`\n  ${G.check}  ${done.length} file(s) vanished from all git history.\n`));
    console.log(chalk.gray('  Your copies are still on disk with their latest content, now untracked.\n'));

    // filter-repo removed the remotes, so "git push origin" would fail here:
    // show the real publish steps and offer to put the remotes back.
    printPublishSteps(remotes);
    await offerRemoteRestore(ctx.repoPath, remotes);
    console.log(chalk.gray('  Collaborators must re-clone, or: git fetch --all && git reset --hard origin/<branch>'));
    console.log(chalk.gray('  Rotate any leaked credentials — hosts may have cached the old content.\n'));
    if (backup) console.log(chalk.gray(`  Undo everything with:  ${restoreHint(backup)}\n`));
  });

  return true;
}

/* ─── home screen ────────────────────────────────────────── */

async function runApp(ctx) {
  const ui = new Ui();
  ui.open();

  // `git-vanish reassign` should land on the reassign screen, not the menu.
  let jumpTo = ctx.startAt;

  try {
    for (;;) {
      ctx.stats = repoStats(ctx.repoPath);
      const s = ctx.stats;

      const action = jumpTo || await ui.menu({
        title: 'What would you like to remove from this repository?',
        crumb: 'Home',
        right: ctx.repoName,
        items: [
          {
            icon: '🗑', label: 'Vanish files',
            hint: 'delete a file from every commit', value: 'vanish',
          },
          {
            icon: '🙈', label: 'Redact a secret',
            hint: 'replace a leaked string, keep the file', value: 'redact',
          },
          {
            icon: '👤', label: 'Reassign a contributor',
            hint: 'move commits to another identity', value: 'reassign',
          },
          {
            icon: '📋', label: 'List contributors',
            hint: 'read-only', value: 'contributors',
          },
          { icon: '🚪', label: 'Quit', value: 'quit' },
        ],
        note: theme.dim(
          `  ${plural(s.commits, 'commit')}  ·  ${plural(s.people, 'identity', 'identities')}`
          + `  ·  ${plural(s.tracked, 'tracked file')}  ·  ${plural(s.branches, 'branch', 'branches')}\n`,
        ) + theme.dim(`  ${ctx.repoPath}`),
      });

      if (!action || action === 'quit') return;

      let finished = false;
      if (action === 'vanish')        finished = await vanishFlow(ui, ctx);
      else if (action === 'redact')   finished = await redactFlow(ui, ctx);
      else if (action === 'reassign') finished = await reassignFlow(ui, ctx);
      else if (action === 'authors' || action === 'contributors') {
        finished = await contributorsFlow(ui, ctx);
      }

      if (finished) return;   // a rewrite ran and printed its report

      // Backing out of a screen we jumped straight into returns to the menu
      // rather than quitting, so the app is never a dead end.
      jumpTo = null;
    }
  } finally {
    ui.close();
  }
}

module.exports = { runApp, vanishFlow, reassignFlow, redactFlow, repoStats, dirtyFiles };
