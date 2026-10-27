# git-vanish 🔥

![git-vanish](./git-vanish.png)

> A terminal app for the three things you can't undo with a normal commit:
> **vanish a file from every commit**, **redact a leaked secret**, or
> **reassign a contributor's commits** to someone else.

## The problem

You `git push`ed a file containing secrets (API keys, passwords, `.env`, `credentials.json`, etc.) to GitHub. Once it's in history, just deleting the file and committing again is **not enough** — the secret is still visible in every past commit.

`git-vanish` surgically rewrites **every single commit** across all branches and tags, while preserving the rest of your history exactly as it was.

---

## Install globally

```bash
npm install -g git-vanish
```

---

## Usage

Run inside any git repository:

```bash
git-vanish
```

That opens the interactive app — a home screen with the four operations, then a
step-by-step wizard for whichever one you pick:

```
 🔥 git-vanish  › Home                                            my-project

 What would you like to remove from this repository?
 ─────────────────────────────────────────────────────────────────────────
 ▸ 1  🗑  Vanish files                      delete a file from every commit
   2  🙈  Redact a secret            replace a leaked string, keep the file
   3  👤  Reassign a contributor           move commits to another identity
   4  📋  List contributors                                      read-only
   5  🚪  Quit

   248 commits  ·  6 identities  ·  91 tracked files  ·  3 branches

  ↑↓ move   1-9 jump   enter select   click select   esc back
```

Every screen works with **arrows or vi keys, Enter or a mouse click**, and every
destructive step ends on a confirmation dialog whose default button is *Cancel*.

Jump straight to one screen if you already know what you want:

```bash
git-vanish vanish      # the file picker
git-vanish redact      # the secret form
git-vanish reassign    # the contributor picker
git-vanish authors     # who is in history (read-only)
```

### Options

| Flag                | Description                                   |
| ------------------- | --------------------------------------------- |
| `-r, --repo <path>` | Path to git repo (default: current directory) |
| `-f, --file <path>` | Skip the browser — provide the file path directly |
| `--dry-run`         | Preview what would happen, no changes made    |
| `--no-gc`           | Skip the aggressive garbage collection step   |
| `-y, --yes`         | Vanish `--file` without the confirmation screens (scripts, agents, no terminal) |
| `--no-backup`       | With `--yes`: skip the backup bundle written before the rewrite |
| `--restore-remotes` | After a non-interactive rewrite (vanish, redact, reassign), re-add the remotes `git-filter-repo` removed |
| `-V, --version`     | Show version                                  |
| `-h, --help`        | Show help                                     |


### Examples

```bash
# The interactive app
git-vanish

# Vanish a specific file (still shows every review and confirmation screen)
git-vanish --file config/secrets.json

# Preview only (no changes)
git-vanish --dry-run

# Without a terminal (scripts, CI, AI agents): explicit consent with --yes.
# Writes a backup bundle first, verifies the file is gone afterwards.
git-vanish --file config/secrets.json --dry-run          # report only
git-vanish --file config/secrets.json --yes              # do it
git-vanish --file config/secrets.json --yes --restore-remotes   # and put origin back

# Different repo
git-vanish --repo /path/to/my-project
```

Every operation is also available non-interactively via flags, for scripts and
for people who already know exactly what they want — see the sections below.

---

## Redaction mode — when the secret is *inside* a file you need to keep

Vanishing a whole file is right for something that should never have been tracked
(`.env`, `credentials.json`). It's the wrong move when the leak is a hardcoded
password or token inside a real source file: removing the file would delete that
source from every historical commit.

Redaction mode rewrites the **content** instead. Every occurrence of the secret
across all commits, branches and tags becomes a placeholder, and the files stay
exactly where they are, still tracked.

```bash
# one or more secrets, repeatable
git-vanish --secret "hunter2" --secret "my-db-password"

# preview first — always do this
git-vanish --secret "hunter2" --dry-run

# read them from a file instead, so they never touch your shell history
git-vanish --secrets-file ./leaked-secrets.txt
```

| Flag                    | Description                                                |
| ----------------------- | ---------------------------------------------------------- |
| `-s, --secret <text>`   | Literal string to redact from all history (repeatable)     |
| `--secrets-file <path>` | One secret per line; `#` comments and blank lines ignored  |
| `--replacement <text>`  | Substituted text (default `***REMOVED***`)                 |

Notes:

- Requires **git-filter-repo** (`brew install git-filter-repo` / `pip install git-filter-repo`).
  `filter-branch` can't do this safely — it would need a tree-filter rewriting
  every blob on every commit.
- The working tree must be clean; history rewriting touches every commit.
- Secrets are **masked** in all terminal output, and the temp replacement list is
  deleted afterwards.
- After the rewrite, git-vanish re-checks every secret and **fails loudly** if any
  occurrence survived.
- `git-filter-repo` removes your `origin` remote on purpose. Re-add it and force-push:

  ```bash
  git remote add origin <url>
  git push --force --all && git push --force --tags
  ```

⚠️ **Redaction is not a substitute for rotating the secret.** Anyone who cloned
before the rewrite still has it, and hosts like GitHub can keep old commits
reachable by SHA until they garbage-collect. Rotate first, redact second.

---

## Reassign authorship — when a *person* has to come out of the history

A contributor leaves and their identity should not stay on every commit: a
personal email that was never meant to be public, a closed account, or several
identities that should be one.

Every commit, file, message and date is preserved. Only the author and
committer change, so `git log --stat` reads exactly the same afterwards.

### An identity hides in three places

GitHub builds its contributor sidebar from all three, and git-vanish reads all
three:

| Role | Where it lives | Can it be removed? |
| --- | --- | --- |
| **author** | commit header | No — reassign it; every commit needs an author |
| **committer** | commit header | No — reassign it |
| **co-author** | `Co-authored-by:` trailer in the message body | **Yes** — the line is optional |

The third one is the one that surprises people. A `Co-authored-by:` trailer is
ordinary text in the commit message, so it is invisible to `git log --format`,
untouched by `.mailmap`, and **counted by GitHub anyway**. That is how an
identity ends up owning a slot in your contributor list without appearing on a
single commit's author line — the usual culprits being AI assistants, pairing
partners and patch forwarders.

`--list-authors` breaks the three apart so you can see which you are dealing
with:

```
   identity                                 authored   committed   co-authored   total
   zamansheikh <zaman6545@gmail.com>              31          31             0      62
   Claude Fable 5 <noreply@anthropic.com>          0           0             7       7
   Claude Opus 4.8 <noreply@anthropic.com>         0           0             1       1
```

Two display names, one email, no commits authored: everything above the human
comes from message trailers. Remove it with one command — matching is by email,
so both display names go together:

```bash
git-vanish --remove-coauthor "noreply@anthropic.com"
```

Or pick **"Nobody — remove them from the commits"** in the interactive wizard,
which offers that option whenever the selected identity appears in trailers
alone. The trailer line is deleted whole, the rest of every message is left
byte-for-byte identical, and the commit count is verified unchanged.

### Interactively

```bash
git-vanish reassign
```

The wizard walks you through it: tick whose commits are moving (several at once
to merge identities), choose where they go, review the exact mapping with real
commit counts, take a backup, confirm.

```
 🔥 git-vanish  › Reassign contributor                             my-project

 Whose commits are moving?   1 selected
 ─────────────────────────────────────────────────────────────────────────
   [✓] Alice Dev <alice@old.example>              14 refs · 9 authored
 ▸ [ ] Bob <bob@corp.example>                      6 refs · 6 authored

   Matching is by email, so every display name this person used is included.
   Tick several to merge them all onto one identity.
```

Where the commits go is a choice of three: **type a new identity**, pick an
**existing contributor** (which merges the two), or **anonymise** to a GitHub
noreply address.

### From flags

```bash
# See who is actually in there first
git-vanish --list-authors

# Move everything from one identity to another
git-vanish --reassign "Old Name <old@mail.com>=New Name <new@mail.com>"

# The left side can be a bare email — it is matched on email anyway
git-vanish --reassign "old@mail.com=New Name <new@mail.com>"

# Preview it
git-vanish --reassign "old@mail.com=New Name <new@mail.com>" --dry-run

# Several at once, merging two identities into one
git-vanish \
  --reassign "alice@old.com=Alice <alice@new.com>" \
  --reassign "bob@laptop.local=Bob <bob@new.com>"

# Fix a display name without changing the email
git-vanish --reassign "bob <bob@corp.com>=Bob Smith <bob@corp.com>"

# Delete someone's Co-authored-by: trailers entirely
git-vanish --remove-coauthor "noreply@anthropic.com"

# Or point those trailers at a real person instead of deleting them
git-vanish --reassign "noreply@anthropic.com=Jane Doe <jane@example.com>"
```

| Flag | Description |
| --- | --- |
| `--list-authors` | Everyone in history with authored/committed/co-authored/total counts, then exit |
| `--reassign <mapping>` | `"Old <old@mail>=New <new@mail>"` (repeatable) |
| `--remove-coauthor <identity>` | Delete this identity's `Co-authored-by:` trailers (repeatable) |

Notes:

- Matching is by **email**, so someone who committed under several display
  names is caught by one rule. The left-hand name is for your benefit only.
- The **author**, the **committer**, the **tagger** on annotated tags, and
  `Co-authored-by:` **trailers** are all rewritten. Missing the committer is the
  usual mistake: a rebase or squashed merge leaves a person as committer on work
  they did not author, and half the history keeps their name. Missing the
  trailer is the other one, and it is the one that keeps them in GitHub's
  sidebar. `--list-authors` shows all three columns so you can see which applies.
- `--remove-coauthor` refuses to run against someone who actually authored or
  committed something, and tells you to reassign them instead — a commit cannot
  be left without an author.
- Afterwards git-vanish **verifies** that the old identity is gone and that the
  commit count is unchanged, and fails loudly rather than leaving you with
  something bad to force-push.
- `git-filter-repo` deletes your remotes as a safety measure. git-vanish records
  them beforehand and prints the exact `git remote add` command back to you —
  URL included — and offers to re-add them for you.
- Requires **git-filter-repo**, and a clean working tree.

⚠️ This removes *attribution*, not copyright. If the person holds copyright in
the code, their licence terms still apply whatever the metadata says. And it
only rewrites this copy — existing clones and forks keep the original identity
until they re-clone.

---

## Keyboard and mouse

Every screen shows its own keys in the bar along the bottom, so there is nothing
to memorise. The bindings are consistent throughout:

| Key                      | Action                                          |
| ------------------------ | ----------------------------------------------- |
| `↑` `↓` or `j` `k`       | Move                                            |
| `Enter`                  | Select / open / continue                        |
| `Esc` or `q`             | Back one screen (never destructive)             |
| `1`–`9`                  | Jump straight to a numbered menu item           |
| `Space`                  | Tick a checkbox                                 |
| `Tab`                    | Next field / switch dialog button               |
| `Page Up/Down`, `Home`, `End` | Jump around a long list                    |
| `Ctrl+C`                 | Quit, restoring the terminal                    |

**Mouse**: click a row to select it, click a folder to open it, click a dialog
button, and scroll with the wheel. Set `GIT_VANISH_NO_MOUSE=1` if you would
rather keep your terminal's own text selection unmodified.

In the **file picker** specifically:

| Key            | Action                                                     |
| -------------- | ---------------------------------------------------------- |
| `→`            | Open the folder under the cursor                            |
| `←`            | Go up one folder                                            |
| `s`            | Search **every tracked path in the repo** (fuzzy)            |
| `/`            | Filter the current folder                                    |
| `a` / `n`      | Tick every tracked file here / clear the selection           |

The picker marks untracked files with 🔒 and refuses to queue them — there is
nothing in history to remove, and letting you pick one would only waste a
rewrite.

---

## What it does (step by step)

1. **Finds your git repo root** (walks up from cwd)
2. **Loads all git-tracked files** — both current and historic
3. **Opens the picker** — browse folders, or press `s` to search every tracked path
4. **Shows every commit** that ever contained the file
5. **Offers a backup bundle**, then **confirms** on a dialog defaulting to Cancel
6. **Rewrites history** using `git filter-repo` (if installed) or `git filter-branch` (built into git) — removes the file from every commit
7. **Cleans up** reflogs and runs `git gc --aggressive --prune=now`
8. **Adds the file to `.gitignore`** so it can never be committed again
9. **Prints force-push commands** to update your remote

Steps 6 onwards run in the **normal terminal**, not the full-screen app, so the
record of what happened to your history stays in your scrollback.

---

## The backup bundle

Before any rewrite, git-vanish offers to run `git bundle create` — one file,
next to your repo folder, containing every ref and object as they were.

```bash
git clone my-project-backup-2026-08-14T12-30-00.bundle restored-repo
```

That is the whole undo story for an operation git itself cannot undo. Take it.

---

## After running

`git-filter-repo` removes your remotes so a bad rewrite cannot be pushed by
accident. The interactive app offers to put them back; from flags, add
`--restore-remotes` (or run the `git remote add …` line it prints).

Then you **must** force-push to update the remote:

```bash
git push origin --force --all
git push origin --force --tags
```

Then **rotate any leaked secrets immediately** (GitHub and other platforms may cache content in their CDN even after a rewrite).

All collaborators must re-clone or run:

```bash
git fetch --all
git reset --hard origin/<branch>
```

---

## Speed tip — `git filter-repo`

`git-vanish` automatically prefers [`git-filter-repo`](https://github.com/newren/git-filter-repo) if it's installed — it's ~10-50× faster than `filter-branch` on large repos.

```bash
pip install git-filter-repo
# or
brew install git-filter-repo
```

---

## How history rewriting works

```
Before scrub:
  commit A  – adds secret.json ← 🔒 secret visible here
  commit B  – other changes
  commit C  – other changes
  commit D  – deletes secret.json
  commit E  – other changes   ← HEAD (secret STILL in history)

After scrub:
  commit A' – (secret.json never existed)
  commit B' – other changes   (identical diff, different hash)
  commit C' – other changes
  commit D' – (empty commit pruned if nothing else changed)
  commit E' – other changes   ← HEAD (clean history)
```

All other files, diffs, messages, authors, and timestamps are preserved exactly.

---

## Running it on a repo you have already filtered

Perfectly fine — git-vanish handles it. Worth knowing what is going on
underneath, though, because `git filter-repo` leaves a marker at
`.git/filter-repo/already_ran` after every successful run, and more than a day
later it wants to know whether the next run continues the previous one:

```
The previous run is older than a day (.git/filter-repo/already_ran already exists).
Treat this run as a continuation of filtering in the previous run (Y/N)?
```

`--force` does not suppress that question. git-vanish settles it before
invoking the tool, so you never see the prompt: it keeps the previous run's
metadata when the metadata is complete, so `.git/filter-repo/commit-map` goes
on mapping the SHAs your repository had before *any* filtering, and starts a
fresh map when it is not. You will see one line saying which:

```
This repository has been filtered before — continuing that history.
```

The rewrite itself is identical either way; only the bookkeeping differs.

---

## Requirements

- Node.js ≥ 14
- Git ≥ 2.x (must be in PATH)
- [`git-filter-repo`](https://github.com/newren/git-filter-repo) for redaction
  and contributor reassignment. Vanishing files works without it, falling back
  to `filter-branch`.
- A terminal for the interactive app. Without one (a pipe, a CI job) use the
  flags; git-vanish will tell you so rather than hanging on a prompt.

---

## License

MIT
