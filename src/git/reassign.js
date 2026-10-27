'use strict';

/**
 * Reassign commit authorship across all history.
 *
 * The third thing people need from history rewriting, after removing a file
 * and redacting a string: a contributor leaves and their identity has to come
 * off the commits — a personal email that should never have been public, an
 * account being closed, contributions consolidated onto one identity.
 *
 * Every commit, file and message is preserved exactly. Only the author and
 * committer identity changes, so `git log --stat` reads the same afterwards.
 *
 * Implemented with `git filter-repo --mailmap`, which is the supported path
 * for this: it rewrites author, committer AND tagger fields, and matches on
 * email, so a person who committed under several display names is caught by
 * one rule.
 *
 * ── Worth knowing before you run it ──────────────────────────────────────
 * This removes attribution. If the person holds copyright in the code, their
 * licence terms still apply regardless of what the commit metadata says —
 * rewriting the name does not transfer authorship in any legal sense.
 * It also only affects THIS copy: existing clones, forks and anything the
 * host has already cached keep the original identity until they re-clone.
 */

const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

function run(cmd, cwd, { silent = false, failOk = false } = {}) {
  const res = spawnSync(cmd, {
    cwd,
    shell: true,
    stdio: silent ? 'pipe' : 'inherit',
    env: { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: '1' },
  });
  if (res.status !== 0 && !failOk) {
    const detail = [res.stdout, res.stderr]
      .map((b) => (b ? b.toString().trim() : ''))
      .filter(Boolean)
      .join('\n');
    throw new Error(detail || `Command failed: ${cmd}`);
  }
  return res.stdout ? res.stdout.toString() : '';
}

const { hasFilterRepo, runFilterRepo } = require('./filterrepo');

/**
 * `Co-authored-by:` trailers, anywhere in a commit message.
 *
 * This is the third place an identity hides, and the one everybody misses.
 * GitHub builds its contributor list from these trailers as well as from the
 * author and committer fields, so a person can own a repository's contributor
 * sidebar while appearing on no commit's author line at all — which is exactly
 * what happens to every repo where an AI assistant, a pairing partner or a
 * patch-forwarder gets credited this way.
 *
 * Matched case-insensitively and per line: git's own trailer parsing accepts
 * any capitalisation, and different tools emit different ones.
 */
const COAUTHOR_RE = /^[ \t]*co-authored-by:[ \t]*(.+?)[ \t]*$/gim;

/** Every `Co-authored-by:` identity in one commit message. */
function coauthorsIn(message) {
  const found = [];
  COAUTHOR_RE.lastIndex = 0;
  let m;
  while ((m = COAUTHOR_RE.exec(message)) !== null) {
    const id = parseIdentity(m[1]);
    if (id && id.email) found.push(id);
  }
  return found;
}

/**
 * Every identity in history, with how often it appears and in what role.
 *
 * Reads authors, committers AND co-author trailers. Each matters for a
 * different reason:
 *
 *  • author    — who wrote it
 *  • committer — a rebase or squashed merge leaves someone as committer on
 *                commits they did not author, and a reassignment that misses
 *                those leaves the identity behind in half the history
 *  • co-author — a trailer in the message body, invisible to `git log --format`
 *                and untouched by mailmap, but counted by GitHub
 *
 * Records are separated with \x01 and fields with NUL, because both a display
 * name and a commit message are free text: "Foo | Bar" is a legal git name and
 * would split a pipe-delimited line in the wrong place.
 */
function listAuthors(repoPath, { includeRemotes = false } = {}) {
  // Local branches and tags, not `--all`.
  //
  // `--all` includes refs/remotes/*, which is a cache of what the server had
  // at the last fetch — not history we own or can rewrite. Counting it means
  // that in the window between rewriting and force-pushing, every identity you
  // just removed reappears in the listing, with every count doubled, and the
  // post-rewrite verification declares its own successful rewrite a failure.
  // The remote is fixed by pushing, not by filtering it again.
  const scope = includeRemotes ? ['--all'] : ['--branches', '--tags', 'HEAD'];
  const out = spawnSync(
    'git',
    ['log', ...scope, '--pretty=format:%x01%an%x00%ae%x00%cn%x00%ce%x00%B'],
    { cwd: repoPath, stdio: 'pipe', maxBuffer: 256 * 1024 * 1024 },
  );
  if (out.status !== 0) {
    throw new Error('Could not read git history — is this a git repository?');
  }

  const people = new Map();
  const add = (name, email, role) => {
    const clean = String(email || '').trim();
    if (!clean) return;
    const key = `${name}\x00${clean}`;
    const entry = people.get(key)
      || { name, email: clean, authored: 0, committed: 0, coauthored: 0, count: 0 };
    entry[role] += 1;
    entry.count += 1;
    people.set(key, entry);
  };

  for (const record of out.stdout.toString().split('\x01')) {
    if (!record) continue;
    const parts = record.split('\x00');
    if (parts.length < 5) continue;

    const [an, ae, cn, ce] = parts;
    // A message could in principle contain a NUL; put it back together.
    const body = parts.slice(4).join('\x00');

    add(an, ae, 'authored');
    add(cn, ce, 'committed');
    for (const co of coauthorsIn(body)) add(co.name, co.email, 'coauthored');
  }

  return [...people.values()].sort(
    (a, b) => b.count - a.count || a.email.localeCompare(b.email),
  );
}

/**
 * Where one email appears, summed across every display name it used.
 * The UI needs this to know whether an identity can simply be dropped: a
 * trailer can be deleted, an author field cannot — a commit must have an author.
 */
function identityRoles(repoPath, email) {
  const lower = String(email).toLowerCase();
  const roles = { authored: 0, committed: 0, coauthored: 0, total: 0 };
  for (const a of listAuthors(repoPath)) {
    if (a.email.toLowerCase() !== lower) continue;
    roles.authored += a.authored;
    roles.committed += a.committed;
    roles.coauthored += a.coauthored;
    roles.total += a.count;
  }
  return roles;
}

/** How many references still carry this email, in any of the three roles. */
function countFor(repoPath, email) {
  const lower = String(email).toLowerCase();
  return listAuthors(repoPath)
    .filter((a) => a.email.toLowerCase() === lower)
    .reduce((sum, a) => sum + a.count, 0);
}

/**
 * `Name <email>` → {name, email}.
 *
 * A bare `someone@example.com` is accepted too: it is what people copy out of
 * `git log`, and demanding angle brackets for the side of the mapping where
 * the name is ignored anyway is pure ceremony.
 */
function parseIdentity(text) {
  const s = String(text || '').trim();
  if (!s) return null;

  const bracketed = /^(.*?)\s*<([^>]+)>$/.exec(s);
  if (bracketed) {
    const email = bracketed[2].trim();
    return email ? { name: bracketed[1].trim(), email } : null;
  }
  if (/^[^\s<>@]+@[^\s<>@]+$/.test(s)) return { name: '', email: s };
  return null;
}

/**
 * Split `Old <old@mail>=New Name <new@mail>` on the separator.
 *
 * Splitting on the first `=` breaks names that legitimately contain one
 * ("Team A=B <t@x>"), so an `=` that directly follows the closing bracket of
 * an identity wins; the first `=` is only the fallback for the bare-email form.
 */
function parseMapping(raw) {
  const s = String(raw || '');
  const afterBracket = /^(.*?>)\s*=\s*(.+)$/.exec(s);
  if (afterBracket) return { from: afterBracket[1].trim(), to: afterBracket[2].trim() };

  const at = s.indexOf('=');
  if (at < 0) return null;
  const from = s.slice(0, at).trim();
  const to = s.slice(at + 1).trim();
  if (!from || !to) return null;
  return { from, to };
}

/**
 * Turn raw mapping strings into validated operations.
 *
 * A pair whose `to` is null or empty means "delete this person's co-author
 * trailers" rather than "move them somewhere". That is a genuinely different
 * operation and only legal for someone who appears in trailers alone — every
 * commit needs an author, so an author field can be reassigned but never
 * deleted.
 */
function buildMappings(pairs) {
  return pairs.map((pair) => {
    const from = parseIdentity(pair.from);
    if (!from) throw new Error(`Could not parse identity "${pair.from}" — expected: Name <email>`);

    if (pair.remove || pair.to === null || pair.to === '') {
      return { from, to: null, remove: true };
    }

    const to = parseIdentity(pair.to);
    if (!to) throw new Error(`Could not parse identity "${pair.to}" — expected: Name <email>`);
    if (!to.name) throw new Error(`The new identity needs a display name: "${pair.to}"`);
    if (from.email.toLowerCase() === to.email.toLowerCase() && from.name === to.name) {
      throw new Error(`"${pair.from}" and "${pair.to}" are the same identity — nothing to change.`);
    }
    // These strings become lines in git-filter-repo's replacement file, whose
    // format uses `==>` as the separator and one rule per line.
    for (const part of [to.name, to.email, from.email]) {
      if (part.includes('==>') || /[\r\n]/.test(part)) {
        throw new Error(`Identity contains characters that cannot be rewritten safely: "${part}"`);
      }
    }
    return { from, to, remove: false };
  });
}

/** What a reassignment would touch, without touching anything. */
function previewReassign(repoPath, pairs) {
  return buildMappings(pairs).map((m) => ({
    ...m,
    refs: countFor(repoPath, m.from.email),
    roles: identityRoles(repoPath, m.from.email),
  }));
}

/** Remotes recorded before the rewrite — filter-repo drops them. */
function captureRemotes(repoPath) {
  const out = spawnSync('git', ['remote', '-v'], { cwd: repoPath, stdio: 'pipe' });
  if (out.status !== 0) return [];
  const seen = new Map();
  for (const line of out.stdout.toString().split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (m && !seen.has(m[1])) seen.set(m[1], m[2]);
  }
  return [...seen.entries()].map(([name, url]) => ({ name, url }));
}

/**
 * Re-add remotes that a filter-repo run removed. Only remotes that are now
 * missing are added; nothing is fetched or pushed.
 *
 * @returns {{name: string, url: string}[]} the remotes that were re-added
 */
function restoreRemotes(repoPath, remotes) {
  const restored = [];
  for (const r of remotes || []) {
    const exists = spawnSync('git', ['remote', 'get-url', r.name], { cwd: repoPath, stdio: 'pipe' }).status === 0;
    if (exists) continue;
    const add = spawnSync('git', ['remote', 'add', r.name, r.url], { cwd: repoPath, stdio: 'pipe' });
    if (add.status === 0) restored.push(r);
  }
  return restored;
}

/** Escape a string for use inside a Python regular expression. */
function reEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rules for git-filter-repo's `--replace-message`, one per line, in its
 * `pattern==>replacement` format.
 *
 * mailmap cannot reach a co-author trailer — it rewrites the author, committer
 * and tagger headers, and a trailer is ordinary text in the message body. So
 * trailers are handled here instead, matched on email so every display name the
 * person was credited under is caught by one rule.
 */
function messageRules(mappings) {
  const rules = [];
  let removed = false;

  for (const m of mappings) {
    const email = reEscape(m.from.email);

    if (m.remove) {
      // Swallow the newline BEFORE the trailer so the line disappears whole
      // rather than leaving an empty one behind.
      rules.push(`regex:(?i)\\n[ \\t]*co-authored-by:[ \\t]*[^\\n]*<${email}>[^\\n]*==>`);
      removed = true;
    } else {
      // Backslashes are meaningful in a re.sub replacement template.
      const to = `Co-authored-by: ${m.to.name} <${m.to.email}>`.replace(/\\/g, '\\\\');
      rules.push(`regex:(?im)^[ \\t]*co-authored-by:[ \\t]*[^\\n]*<${email}>[^\\n]*$==>${to}`);
    }
  }

  // Deleting the last trailer leaves the message ending in a blank line. Tidy
  // that up — but only when something was actually deleted, so a pure
  // reassignment leaves every other message byte-for-byte identical.
  if (removed) rules.push('regex:\\n\\s*\\n\\s*$==>\\n');

  return rules;
}

/**
 * @param {string} repoPath
 * @param {Array<{from: string, to: string|null, remove?: boolean}>} pairs
 *        each side as `Name <email>`; a null/empty `to` deletes the person's
 *        co-author trailers instead of moving them
 * @param {{dryRun?: boolean}} opts
 */
async function reassignAuthors(repoPath, pairs, opts = {}, onProgress = console.log) {
  if (!hasFilterRepo()) {
    throw new Error(
      'git-filter-repo is required for author reassignment but was not found.\n' +
        '  Install it with:  brew install git-filter-repo\n' +
        '                    (or) pip install git-filter-repo',
    );
  }

  const mappings = buildMappings(pairs);

  // Report scope before doing anything irreversible.
  const found = [];
  for (const m of mappings) {
    const roles = identityRoles(repoPath, m.from.email);
    const n = roles.total;

    if (n === 0) {
      onProgress(chalk.gray(`  ${m.from.email} → not present in history, skipping`));
      continue;
    }

    // A commit must have an author, so an author or committer field can be
    // moved to someone else but never simply deleted.
    if (m.remove && (roles.authored > 0 || roles.committed > 0)) {
      throw new Error(
        `"${m.from.email}" is the author or committer of ${roles.authored + roles.committed} ` +
          'commit ref(s), not just a co-author trailer. Every commit needs an author, so this ' +
          'identity has to be reassigned to someone rather than removed.',
      );
    }

    const where = [
      roles.authored ? `${roles.authored} authored` : null,
      roles.committed ? `${roles.committed} committed` : null,
      roles.coauthored ? `${roles.coauthored} co-authored` : null,
    ].filter(Boolean).join(', ');

    onProgress(chalk.yellow(
      m.remove
        ? `  ${m.from.email} → removing co-author trailer  (${where})`
        : `  ${m.from.email} → ${m.to.name} <${m.to.email}>  (${where})`,
    ));
    found.push({ ...m, roles });
  }

  if (found.length === 0) {
    onProgress(chalk.green('  Nothing to reassign — none of those identities appear in history.'));
    return { changed: false };
  }

  if (opts.dryRun) {
    onProgress(chalk.cyan('  --dry-run: stopping before any changes.'));
    return { changed: false, dryRun: true, mappings: found };
  }

  const remotes = captureRemotes(repoPath);
  const before = run('git rev-list --all --count', repoPath, { silent: true }).trim();

  // mailmap format: `New Name <new@email> <old@email>` — match on old email,
  // which catches every display name the person ever committed under. Only the
  // reassignments go here; a removal has no target to map to.
  const moves = found.filter((m) => !m.remove);
  const rules = messageRules(found.filter((m) => m.remove || m.roles.coauthored > 0));

  const stamp = Date.now();
  const mailmapPath = path.join(os.tmpdir(), `git-vanish-mailmap-${stamp}.txt`);
  const messagePath = path.join(os.tmpdir(), `git-vanish-messages-${stamp}.txt`);
  const argv = ['--force'];

  if (moves.length > 0) {
    fs.writeFileSync(
      mailmapPath,
      moves.map((m) => `${m.to.name} <${m.to.email}> <${m.from.email}>`).join('\n') + '\n',
      'utf8',
    );
    argv.push('--mailmap', mailmapPath);
  }
  if (rules.length > 0) {
    fs.writeFileSync(messagePath, rules.join('\n') + '\n', 'utf8');
    argv.push('--replace-message', messagePath);
  }

  try {
    onProgress(rules.length > 0
      ? 'Rewriting history with git filter-repo (identities and message trailers)…'
      : 'Rewriting history with git filter-repo --mailmap…');
    // Output is captured, not inherited: filter-repo interleaves progress
    // counters with its own notices, and the useful part is the summary below.
    runFilterRepo(repoPath, argv, { onProgress });
    onProgress('Rewrite complete.');
  } finally {
    for (const p of [mailmapPath, messagePath]) {
      try { fs.unlinkSync(p); } catch {}
    }
  }

  onProgress('Expiring reflogs and collecting garbage…');
  run('git reflog expire --expire=now --all', repoPath, { failOk: true, silent: true });
  run('git gc --prune=now', repoPath, { failOk: true, silent: true });

  // Nothing but identity should have moved. A changed commit count means
  // something else happened and the user needs to know before they force-push.
  const after = run('git rev-list --all --count', repoPath, { silent: true }).trim();
  if (before !== after) {
    throw new Error(
      `Commit count changed (${before} -> ${after}). Reassignment should preserve every ` +
        'commit — do not push this. Restore from your backup.',
    );
  }

  // Verify per mapping, against all three roles. When the new identity keeps
  // the old email — renaming someone rather than replacing them — the email
  // surviving is the expected outcome, so what has to be checked is that no
  // entry still carries the old display name.
  const identities = listAuthors(repoPath);
  const leftovers = [];
  for (const m of found) {
    const oldEmail = m.from.email.toLowerCase();
    const keepsEmail = !m.remove && m.to.email.toLowerCase() === oldEmail;
    const stale = identities.filter(
      (a) => a.email.toLowerCase() === oldEmail && (!keepsEmail || a.name !== m.to.name),
    );
    for (const s of stale) leftovers.push(`${s.name} <${s.email}> (${s.count} left)`);
  }
  if (leftovers.length > 0) {
    throw new Error(`Reassignment incomplete — still present: ${leftovers.join(', ')}`);
  }

  onProgress(chalk.green(`  ✔  Verified: all ${before} commits kept, old identities gone.`));
  return {
    changed: true,
    reassigned: found.length,
    mappings: found,
    commits: Number(before),
    remotes,
  };
}

/**
 * Identities that survive only in remote-tracking refs — i.e. that you have
 * already rewritten locally but not yet force-pushed. Worth reporting, because
 * otherwise the difference between "the rewrite failed" and "you have not
 * pushed yet" is invisible.
 */
function staleOnRemote(repoPath) {
  const local = new Set(listAuthors(repoPath).map((a) => a.email.toLowerCase()));
  return listAuthors(repoPath, { includeRemotes: true })
    .filter((a) => !local.has(a.email.toLowerCase()));
}

/**
 * Delete one or more identities' `Co-authored-by:` trailers from every commit
 * message. Convenience wrapper — the work is the same rewrite.
 *
 * @param {string[]} identities  each as `Name <email>` or a bare email
 */
async function removeCoauthors(repoPath, identities, opts = {}, onProgress = console.log) {
  const pairs = identities.map((from) => ({ from, to: null, remove: true }));
  return reassignAuthors(repoPath, pairs, opts, onProgress);
}

module.exports = {
  reassignAuthors,
  removeCoauthors,
  listAuthors,
  identityRoles,
  coauthorsIn,
  parseIdentity,
  parseMapping,
  buildMappings,
  previewReassign,
  captureRemotes,
  restoreRemotes,
  countFor,
  staleOnRemote,
  hasFilterRepo,
};
