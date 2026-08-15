---
name: dev-init
description: Set up the dev workflow in this project — pick the issue tracker, probe the repo, confirm the project, language, state ladder and check commands with the user, and write .dev-workflow.json. Use when /dev-task, /dev-bug or /dev-done reports missing config, or when the user types /dev-init.
argument-hint: [optional tracker URL, repo slug or project key]
---

# /dev-init — configure the dev workflow for this project

Produces one file, `.dev-workflow.json` at the repo root. Everything `/dev-task`, `/dev-bug` and
`/dev-done` need that is project-specific lives there; nothing under `_dev-workflow/` is edited per
project.

`npx dev-workflow` runs a CLI wizard that covers the **YouTrack** path deterministically, including
reading the project's real state names off the API. If the user would rather click through prompts,
point them at it and stop. It does not yet cover GitHub — a GitHub project is configured here.

## 1. Check what already exists

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" config
```

If a config file is already reported, show it and ask whether to amend or replace it. Never
overwrite an existing `.dev-workflow.json` without saying what will change. The first line of the
summary is the provider, so an existing setup tells you which branch of §3 applies.

## 2. Probe the repo before asking anything

Answer as much as you can from the project itself, and only ask about the rest:

- **Repo layout** — is this one repo or several sibling apps? `ls`, then look for `package.json`,
  `Cargo.toml`, `go.mod`, `pyproject.toml`, `composer.json`, `Gemfile` at the root and one level
  down. Nested `.git` directories mean separate repos, not a monorepo.
- **Check commands** — read the `scripts` block of each `package.json` (or the Makefile, or
  `pyproject.toml`) for the real test / lint / type-check entry points. Prefer a single-run
  target over a watch-mode one; note which is which.
- **Package manager** — a `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json` or a
  `packageManager` field settles it. Cross-manager use is a common failure, so record it.
- **Node/tool pinning** — `.nvmrc`, `.tool-versions`, `mise.toml`. If a pin cannot be resolved by
  the version manager in use, that is exactly the sort of thing the `env` field exists to record.
- **Commit convention** — `commitlint.config.*`, `.commitlintrc*`, `.czrc`, `package.json#commitlint`
  give the allowed types and scopes verbatim. Use those, not the defaults.
- **Base branch** — `git symbolic-ref refs/remotes/origin/HEAD` or `git branch -r`.
- **Remotes** — `git remote -v` per repo. More than one remote usually means branches push to both.
- **Existing conventions** — `git log --oneline -30` shows how issue IDs actually appear in
  subjects on this project, which beats any assumption about prefix vs suffix. It also hints at the
  tracker: `ABC-123` is YouTrack-shaped, `#123` is GitHub-shaped.

## 3. Ask only what the repo cannot tell you

**First, settle the tracker**, because it decides everything else:

> Which issue tracker does this project use — YouTrack, or GitHub Issues?

If `git remote -v` shows a GitHub remote and the commit log carries `#123`, propose GitHub and let
them correct you. Then ask the rest in one batch.

### Common to both

1. **Language for ticket prose** — the language issues are written in, which is often not the
   language the session is conducted in. Default to English if they have no preference.
2. **State ladder** — the states this project moves through, and specifically which one means
   *started*, which means *in review*, and which means *finished*.
3. **How work should reach the base branch.** Ask it in plain terms, because it is a working-style
   question, not a technical one:

   > When a ticket is finished, should it go through a pull request, or land straight on `<base>`?
   > (A solo project usually wants the second — there is nobody to review it.)

   → `delivery.mode`: `pr` or `direct`. Only ask for a **reviewer** if they chose `pr`; a reviewer
   on a `direct` project is a field nothing will ever read.

4. **Where a ticket gets checked out.**

   > Should starting a ticket create a separate working directory (a git worktree), or switch this
   > checkout to the new branch?

   → `branch.mode`: `worktree` or `branch`. Default to `worktree` and say why: starting a ticket
   never disturbs uncommitted work, and `/dev-bug` can file against the running tree while another
   ticket is in progress. If they pick it, tell them to add `.worktrees/` to `.gitignore` — the
   workflow will not write that file itself.

5. **Branch naming.** Propose `<type>/<ID>-<slug>` and show a rendered example for this project.
   The `<type>` comes from a mapping of issue type onto **commit type**, so the branch and the
   commits on it share one vocabulary:

   ```
   Bug → fix    Feature → feat    Task → chore
   ```

   Every value must be one of the project's `commit.types`, which step 2 already detected. If the
   project has an existing convention in `git branch -a`, propose that instead — an established
   naming scheme beats a tidier one.

### YouTrack only

6. **Instance URL** and **project key** (the short prefix in issue IDs, e.g. `RMB`).
7. **Token source** — `$YOUTRACK_TOKEN`, or a 1Password ref (`op://Vault/item/credential`).
   Never ask them to paste the token itself.

YouTrack projects differ wildly on state names; some have no `Fixed`/`Closed` at all.

### GitHub only

6. **Which repository holds the issues** — `owner/name`. If the project spans several repos this is
   required and not a default: `#123` means a different issue in every repository.
7. **Which label marks each rung.** GitHub has no state field, so the ladder is modelled with
   labels, and the mapping is required rather than inferred — a label named after its rung is a
   guess that is right often enough to be dangerous.

   Read the repo's real labels first rather than proposing names:

   ```bash
   gh label list -R <owner/name> --limit 100
   ```

   If suitable labels already exist, map to them. If not, agree the names and **ask before creating
   them** — adding labels to someone's repository is a visible, permanent change:

   ```bash
   gh label create "status: in progress" -R <owner/name> --color ededed
   ```

8. **The first rung needs no label.** A GitHub ladder must start with a rung meaning "untouched" —
   `Backlog`, say — because that is what an issue carrying no ladder label *is*. Without it every
   unlabelled issue would read as in-progress. This is why `states.ladder` is required for GitHub
   and optional for YouTrack.

## 4. Verify the credentials before writing anything

### YouTrack

```bash
YOUTRACK_BASE_URL=<url> YOUTRACK_PROJECT=<key> \
  node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" create --dup-check "test"
```

A `no open issues matched` line or a list of issues both mean success. An auth or project error
means the config is wrong — fix it now rather than writing a file that fails on first use.

To confirm the state names, fetch any real issue with `dev.mjs fetch` and read the `State` line. Do
not invent state names: a state YouTrack does not recognise returns 400, or worse, 200 without
applying anything.

### GitHub

There is no token to verify — authentication is whatever `gh` already has:

```bash
gh auth status
gh --version          # 2.28 or newer
gh repo view <owner/name> --json nameWithOwner,viewerPermission
```

`viewerPermission` must not be `READ`; the workflow writes. The version floor is not cosmetic:
below 2.28 `gh` omits `stateReason`, and every closed issue then reads as *done* — which would
report work closed as *not planned* as if it had shipped.

Then write the file and confirm the mapping round-trips:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" fetch "#<any existing issue>"
```

The `State:` line must show a rung from the agreed ladder. If it shows the first rung for an issue
you know is in progress, a label is mapped wrongly.

## 5. Write `.dev-workflow.json`

Everything except the provider-specific block below has a working default; omit what does not apply.

### YouTrack

```json
{
  "provider": "youtrack",
  "baseUrl": "https://acme.youtrack.cloud",
  "project": "ABC",
  "tokenOpRef": "op://Private/youtrack/credential",
  "language": "English",
  "states": {
    "start": "In Progress",
    "review": "In Review",
    "done": "Done",
    "ladder": ["Submitted", "Open", "In Progress", "In Review", "Done"]
  },
  "issueTypes": ["Bug", "Feature", "Task", "Epic", "Improvement"],
  "priorities": ["Show-stopper", "Critical", "Major", "Normal", "Minor"],
  "defaultPriority": "Normal"
}
```

### GitHub

```json
{
  "provider": "github",
  "github": {
    "repo": "acme/api",
    "issuesRepo": "acme/api",
    "labels": {
      "In Progress": "status: in progress",
      "In Review": "status: review",
      "Done": "status: done"
    }
  },
  "language": "English",
  "states": {
    "ladder": ["Backlog", "In Progress", "In Review", "Done"],
    "start": "In Progress",
    "review": "In Review",
    "done": "Done"
  },
  "commit": { "idPattern": "#[0-9]+", "position": "suffix" }
}
```

`issuesRepo` may be omitted when it equals `repo` and the project is a single repo. There is no
`baseUrl`, no `tokenOpRef` and no `priorities`: GitHub has no ordered priority concept, and
`/dev-bug` will say so rather than pretend.

### The rest, common to both

```json
{
  "branch": {
    "pattern": "<type>/<ID>-<slug>",
    "base": "main",
    "mode": "worktree",
    "worktreeDir": ".worktrees",
    "types": { "Bug": "fix", "Feature": "feat", "Task": "chore" },
    "fallbackType": "chore"
  },
  "delivery": { "mode": "pr", "remote": "origin", "push": true, "cleanup": true },
  "commit": {
    "pattern": "type(scope): description (<ID>)",
    "position": "suffix",
    "noTicketEscape": "chore(no-ticket)",
    "types": ["feat", "fix", "docs", "refactor", "test", "chore"],
    "scopes": ["api", "ui", "config"],
    "enforce": true,
    "requireType": true
  },
  "reviewer": "octocat",
  "repos": [
    {
      "path": "frontend",
      "when": "UI, pages, forms, translations, components",
      "checks": ["pnpm test:ci", "pnpm lint", "pnpm type-check"],
      "env": { "ASDF_NODEJS_VERSION": "22.22.0" },
      "remotes": ["origin", "upstream"]
    }
  ],
  "notes": ["Anything a future session must know that the code does not say."]
}
```

Field notes:

- `states.ladder` stops a session inventing a state that does not exist. `start` / `review` / `done`
  are the three rungs the skills actually apply, and they are what the commands take — no skill ever
  passes a raw state name.
- `branch.pattern` takes `<type>`, `<ID>` and `<slug>`; a token you leave out is never rendered, so
  `"<ID>-<slug>"` keeps the pre-gitflow names exactly. The branch is what `/dev-done` and `sync`
  read the ticket back out of, so `<ID>` should stay in it.
- `branch.types` maps an **issue** type to a **commit** type, and every value must be one of
  `commit.types` — that is what stops the branch saying `feature/` while its commits say `feat`. An
  issue whose type is not in the map is an error naming the key to add, not a guess.
- `branch.mode: "worktree"` checks each ticket out under `worktreeDir` and leaves this checkout
  alone; `"branch"` switches in place and refuses when the tree is dirty. Add `.worktrees/` to
  `.gitignore` yourself — the workflow writes only `_dev-workflow/` and `.claude/skills/dev-*`.
- `delivery.mode: "direct"` rebases onto `branch.base`, fast-forwards it and pushes, instead of
  opening a pull request. `repos[].delivery` overrides it per repo, so a monorepo can push a library
  straight to `main` while its app still goes through review.
- `commit.idPattern` is a **POSIX ERE**, not a PCRE: the commit hook is bash, where `\b` and `\d` do
  not exist. Omit it and the hook uses the shape implied by the provider.
- `commit.position` is `suffix`, `prefix` or `any`, and the commit hook enforces it.
  `commit.enforce: false` disables the hook entirely; `commit.requireType: false` keeps the
  issue-ID check but drops the conventional-commit one.
- `commit.types` and `commit.scopes` should be **copied from the project's commitlint config**, not
  guessed — the hook and the model both read them.
- `repos` empty (or absent) means a single repo at the project root. With entries, `when` is the
  routing rule `/dev-task` uses to pick a repo and `checks` is what `/dev-done` runs there.
- `env` is prepended to every command run in that repo. Use it for pins the version manager cannot
  resolve on its own.
- `notes` is free-form and is shown to the model on every `/dev-task`, `/dev-bug` and `/dev-done`.

## 6. Confirm it loads, and tell them what is next

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" config
```

Read the summary back and check it matches what was agreed — the provider line first, then the
instance or repo. Then:

- Suggest committing `.dev-workflow.json`. It holds no secret: YouTrack's `tokenOpRef` is a
  1Password *reference*, and GitHub keeps no credential here at all.
- **YouTrack:** if they chose `$YOUTRACK_TOKEN` over 1Password, remind them it must be exported in
  the shell Claude Code runs in, and must not be committed.
- **GitHub:** the ladder labels must exist in the repository. A missing one fails the transition
  with the exact `gh label create` command to fix it — it is never created behind their back.
- Point at `/dev-task <ID>` as the entry point.

## 7. Check the workflow itself is current

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" version
```

Read-only, and it exits 0 with `unknown` rather than failing when there is no network — so a
non-zero exit or an error here is a real problem, not a bad connection.

If it reports an update available, **tell the user and stop there**:

- Give them the command it printed — `npx claude-dev-workflow@latest --update`, or
  `dev.mjs version --upgrade`.
- Say that it rewrites `_dev-workflow/` and `.claude/skills/dev-*`, both of which are committed, so
  it produces a diff they need to review and commit.
- **Never run `--upgrade` unasked**, and never while a ticket is in progress or the tree is dirty.
  `--upgrade` refuses on uncommitted changes in those directories anyway; do not work around it.

If it reports files differing from the manifest, name them. Those are hand edits to installer-managed
files: an update keeps them, which means it also keeps them stale.
