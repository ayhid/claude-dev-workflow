# dev-workflow

Ticket-driven development against your issue tracker — [YouTrack](https://www.jetbrains.com/youtrack/)
or [GitHub Issues](#using-github-issues-instead) — as four Claude Code skills. It installs **per
project** — nothing is registered globally, so the skills exist only in repos that use a tracker.

| Skill         | What it does |
| ------------- | ------------ |
| `/dev-init`    | Probes the repo, asks what it cannot infer, verifies the credentials, writes `.dev-workflow.json`. |
| `/dev-task` | Takes an issue ID **or a plain sentence** — files the issue first when there is none — then agrees acceptance criteria, plans, moves it to *in progress*, checks it out in a worktree, and implements with ticket-referencing commits. |
| `/dev-bug`     | Investigates the likely code path, checks for duplicates, drafts the issue in the project's language, files it on approval. **Never fixes.** |
| `/dev-done`    | Re-reads the ticket, verifies each criterion with evidence, runs the checks, then lands the work the way the project delivers — pull request, or straight onto the base branch. |

Nothing installed is project-specific — instance, project, ticket language, repo layout, state
ladder, branch naming, isolation mode and commit convention all come from one `.dev-workflow.json`
per project.

Each ticket is checked out in its own [git worktree](#configuration) by default, so starting one
never disturbs whatever is already in the tree. Whether finished work goes through a pull request
or lands straight on the base branch is configuration, not a decision the model makes — a solo
project sets `delivery.mode` to `direct` once and is never asked again.

`dev.mjs sync` reconciles the board against GitHub: open PR → review state, merged PR →
done state. See [Keeping states honest](#keeping-states-honest).

A `PreToolUse` hook blocks any `git commit -m` whose subject does not match the configured
convention, with a per-project escape hatch for genuinely ticketless work.

## Install

From the project you want to set up:

```bash
npx claude-dev-workflow@latest
```

An interactive wizard ([`@clack/prompts`](https://github.com/bombshell-dev/clack)) that:

1. asks for the instance URL and where the token comes from — `$YOUTRACK_TOKEN` or a 1Password
   reference — and **verifies it before writing anything**;
2. lists the projects the token can see, so you pick one rather than typing a key;
3. reads that project's **real State / Type / Priority values** from the API, so the config can
   never name a state that does not exist;
4. scans the working tree for repos, package managers, test and lint scripts, commitlint types
   and scopes, runtime pins and git remotes, and shows them for confirmation;
5. infers whether issue IDs go at the prefix or suffix of a commit subject from the last 50
   commits;
6. writes `.dev-workflow.json` and installs the workflow into the project.

It works offline too — if the API is unreachable it says so and falls back to typed answers.

```bash
npx claude-dev-workflow@latest --dir ../other-project   # target somewhere else
npx claude-dev-workflow@latest --print                  # show the config, write nothing
npx claude-dev-workflow@latest --force                  # overwrite files you have edited
```

`npx github:ayhid/claude-dev-workflow` installs the same thing straight from `main`, one release
ahead of npm. It is the slower path — npm resolves a git dependency by installing the repo's dev
toolchain first — so prefer the registry unless you want unreleased work. Cloned locally,
`node bin/install.mjs` is the same thing again.

Released versions are listed under [Releases](https://github.com/ayhid/claude-dev-workflow/releases),
with notes generated from the commit history.

### Updating

```bash
npx claude-dev-workflow@latest --update           # refresh the files, keep your config
npx claude-dev-workflow@latest --update --print   # show what would change, write nothing
npx claude-dev-workflow@latest --update --force   # …and overwrite files you have edited
```

`--update` skips the wizard entirely: it touches `_dev-workflow/`, `.claude/skills/dev-*` and the
hook entry in `.claude/settings.json`, and never reads or writes `.dev-workflow.json`. That matters
for a project on GitHub Issues — the wizard is YouTrack-only and insists on an instance URL such a
project does not have, so re-running it was never a real option.

From inside an installed project:

```bash
node _dev-workflow/scripts/dev.mjs version      # installed vs latest, plus files you have edited
node _dev-workflow/scripts/dev.mjs version --upgrade
```

`version` is read-only and exits 0 even with no network — it prints `unknown` rather than failing.
`--upgrade` runs the `npx` line above for you, and refuses if `_dev-workflow/` or `.claude/skills/`
has uncommitted changes, because an update rewrites those files and you need the diff to be legible.

**Spell it `@latest`.** npx keys its cache on the literal spec string and, on a re-run, only checks
whether the tree it already cached satisfies the range it recorded — `2.0.0` satisfies the `^2.0.0`
it wrote — so a bare `npx claude-dev-workflow` keeps re-running whatever version it saw first,
indefinitely. `latest` is a dist-tag, so it is re-resolved every time. The `github:` form is worse
still: a git spec carries no version to compare, so the cached clone is reused forever. Bust it by
changing the spec — `npx github:ayhid/claude-dev-workflow#v2.1.0`, or a commit sha — rather than by
clearing the cache. (`npx --ignore-existing` was removed in npm 7.)

### Upgrading from v1

v2 renamed the layout and does not migrate the old one. If a project still has a `_youtrack/`
directory, delete it along with `.claude/skills/yt-*` and the `PreToolUse` entry in
`.claude/settings.json` that points at it, then run the installer. Config moved too: rename
`.youtrack.json` to `.dev-workflow.json` — the contents are unchanged.

### What lands in the project

```
your-project/
  .dev-workflow.json                  # your config — edit this
  _dev-workflow/                      # installer-managed runtime; commit it, do not edit
    scripts/  lib/  hooks/
    _config/manifest.json         # version + a sha256 per installed file
  .claude/
    skills/dev-task, dev-bug, dev-done, dev-init
    settings.json                 # the commit hook, merged in alongside your own
```

**`npx claude-dev-workflow@latest --update` updates it.** The installer compares each file against
the hash recorded at install time: untouched files are replaced, files you have edited are reported
and left alone, and files a newer version no longer ships are removed. `--force` overrides that.
Your `.claude/settings.json`
is merged, never overwritten — hooks you added yourself survive, and the entry is not duplicated
on a re-run.

`_dev-workflow/` is meant to be committed: it is how your teammates get the same workflow without
installing anything.

It writes to exactly two places — `_dev-workflow/` and `.claude/skills/dev-*/` — and never touches
anything else, so it sits alongside other skill-based tooling without interfering with it. The one
shared file, `.claude/settings.json`, is merged rather than rewritten: hooks you or another tool
added stay put.

Requirements: Node ≥ 22. `jq` is needed only by the commit hook, and the
[GitHub CLI](https://cli.github.com) only by `dev.mjs sync`. The 1Password CLI (`op`) is optional.
**The installed runtime has no dependencies of its own** — there is no `node_modules` under
`_dev-workflow/`, so it works in a Python, Rust or Go project just as well.

## Configuration

`/dev-init` writes `.dev-workflow.json` at the repo root (`.claude/dev-workflow.json` also works). The
scripts walk up from `$CLAUDE_PROJECT_DIR` to find it, so it works from any subdirectory.

Only `baseUrl` and `project` are required — everything else has a working default.

```json
{
  "baseUrl": "https://acme.youtrack.cloud",
  "project": "ABC",
  "tokenOpRef": "op://Private/youtrack/credential",
  "language": "English",
  "states": { "start": "In Progress", "review": "In Review", "done": "Done", "ladder": [] },
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
    "enforce": true
  },
  "priorities": ["Show-stopper", "Critical", "Major", "Normal", "Minor"],
  "defaultPriority": "Normal",
  "reviewer": "octocat",
  "repos": [
    {
      "path": "frontend",
      "when": "UI, pages, forms, components",
      "checks": ["pnpm test:ci", "pnpm lint"],
      "env": { "ASDF_NODEJS_VERSION": "22.22.0" },
      "remotes": ["origin", "upstream"],
      "scopes": ["feature", "bug", "components"],
      "github": "acme/frontend"
    }
  ],
  "notes": ["Anything a future session must know that the code does not say."]
}
```

### Using GitHub Issues instead

Set `provider` and describe the label ladder. Authentication is the [GitHub CLI](https://cli.github.com)
you already have — there is no token to configure.

```json
{
  "provider": "github",
  "github": {
    "repo": "acme/api",
    "labels": {
      "In Progress": "status: in progress",
      "In Review": "status: review",
      "Done": "status: done"
    }
  },
  "states": {
    "ladder": ["Backlog", "In Progress", "In Review", "Done"],
    "start": "In Progress", "review": "In Review", "done": "Done"
  },
  "commit": { "idPattern": "#[0-9]+" }
}
```

GitHub has no state field, so the ladder is modelled with labels and `done` also closes the issue.
Three things follow, and the tool will tell you about each rather than guessing:

- **The mapping is required.** Every rung except the first needs a label. The first rung — `Backlog`
  above — is what an issue carrying *no* ladder label means, which is why an explicit `states.ladder`
  is required for GitHub: without it, every untouched issue would read as in-progress.
- **Labels must already exist.** A missing one fails with the `gh label create` command to fix it;
  creating labels in a repository is a visible side effect, so it is not done for you.
- **`#123` is per-repository.** For a project spanning several repos, set `github.issuesRepo` to say
  which one holds the issues, or `#123` is ambiguous.

Closing an issue as *not planned* puts it off the ladder, so declined work is never reported as
shipped. Note that GitHub closes issues itself when a PR says `Fixes #12`, which means an issue can
reach *done* without ever passing through *review*.

Notable fields:

- **`language`** — the language ticket *prose* is written in, regardless of the session's
  language. Code identifiers, paths, endpoints and error messages always stay verbatim.
- **`states.ladder`** — the full list of states this project has. It exists to stop a session
  inventing one; `start` / `review` / `done` are the three the skills actually apply. Many
  YouTrack projects have no `Fixed` or `Closed` at all.
- **`commit.position`** — `suffix` (default), `prefix` or `any`. With `suffix`, a bare
  `ABC-1: …` prefix is rejected, matching how commitlint treats it; with `prefix`, the type is
  looked for *after* the ID. `enforce: false` turns the hook off entirely, and
  `requireType: false` keeps the issue-ID check but drops the conventional-commit one, for
  projects that do not use conventional commits.
- **`commit.types` / `scopes`** — copy these from the project's own commitlint config; both the
  hook and the model read them.
- **`commit.noTicketEscape`** — the subject prefix that means *this work genuinely has no issue*.
  The **scope** is what carries that meaning, not the type: with the default `chore(no-ticket)`,
  any configured type wearing that scope is accepted — `feat(no-ticket):`, `fix(no-ticket)!:` —
  so ticketless work is not forced to be a `chore`. That matters if you derive releases from commit
  types, since `chore` is the one type conventional-commits treats as non-releasing.
- **`branch.pattern`** — `<type>`, `<ID>` and `<slug>`. A token the pattern omits is never
  rendered, so pinning `"<ID>-<slug>"` keeps the names this tool produced before branch types
  existed. Keep `<ID>` in it: `/dev-done` and `sync` both read the ticket back out of the branch.
- **`branch.types`** — issue type → **commit** type, so a branch and the commits on it speak one
  vocabulary. Every value must be one of `commit.types`; a value outside it, or an issue type with
  no entry, is an error naming the key to add rather than a silent guess. An issue with no type at
  all uses `fallbackType`.
- **`branch.mode`** — `worktree` (default) checks each ticket out in its own directory under
  `worktreeDir`, so starting a ticket never disturbs work in progress and `/dev-bug` can file
  against the running tree. `branch` switches this checkout in place and refuses when it is dirty.
  Add `.worktrees/` to your `.gitignore`: the installer writes only `_dev-workflow/` and
  `.claude/skills/dev-*`, and will not touch that file for you.
- **`delivery.mode`** — `pr` opens a pull request and lets `sync` move the ticket to the review
  state. `direct` rebases onto `branch.base`, fast-forwards it, pushes, tears the worktree down and
  closes the ticket — which is what a solo project wants. A rebase conflict aborts and reports; it
  is never force-resolved. `push: false` lands locally and pushes nothing; `cleanup: false` keeps
  the worktree and branch after landing.
- **`repos`** — omit for a single-repo project. With entries, `when` is how `/dev-task` routes a
  ticket to a repo, `checks` is what `/dev-done` runs there, `env` is prepended to every command in
  that repo, and `remotes` lists everywhere branches are pushed. `repos[].delivery` overrides the
  top-level block, so one repo in a monorepo can push straight to `main` while another needs a PR.

`.dev-workflow.json` holds no secret — `tokenOpRef` is a 1Password *reference* — so it is meant to
be committed.

Two worked examples live in [`examples/`](examples/): a plain single-repo project, and a
two-repo project with a long state ladder, non-English tickets and per-repo toolchains.

## Credentials

Token resolution order:

1. `$YOUTRACK_TOKEN`
2. 1Password, via `op read "<tokenOpRef>"`

The token is never written to disk and never appears in `argv`: it is passed as an `Authorization`
header on a `fetch` call, and `op read` is given the 1Password *reference* rather than the secret.
Subprocesses are spawned with argument arrays, never an interpolated shell string, so nothing
sensitive can surface in a process listing.

Create a token at *Profile → Account Security → Authentication → New token* with the `YouTrack`
scope.

## Environment overrides

`YOUTRACK_BASE_URL`, `YOUTRACK_PROJECT`, `YOUTRACK_PROJECT_ID`, `YOUTRACK_TOKEN`,
`YOUTRACK_TOKEN_OP_REF`, `YOUTRACK_LANGUAGE` and `YOUTRACK_CONFIG_DIR` all override the config
file. Useful for one-off runs against another instance, and for CI.

## Scripts

They are ordinary CLI tools; the skills just call them.

```bash
node _dev-workflow/scripts/dev.mjs config [--json]                      # effective config
node _dev-workflow/scripts/dev.mjs fetch  ABC-22                        # issue as markdown, comments included
node _dev-workflow/scripts/dev.mjs update ABC-22 "State In Progress"    # apply a command, read the state back
node _dev-workflow/scripts/dev.mjs update ABC-22 "State Done" @/tmp/c.md # …with a comment (literal or @file)
node _dev-workflow/scripts/dev.mjs update ABC-22 comment "note"         # comment only
node _dev-workflow/scripts/dev.mjs create --dup-check "slug 500 router" # open issues matching keywords
node _dev-workflow/scripts/dev.mjs create "Summary" @/tmp/body.md Bug Major   # prints the new ID on stdout
node _dev-workflow/scripts/dev.mjs start  ABC-22                        # branch or worktree, then move to the start state
node _dev-workflow/scripts/dev.mjs start  ABC-22 --print                # …just show the name and path
node _dev-workflow/scripts/dev.mjs land                                 # dry run: how this work would reach the base branch
node _dev-workflow/scripts/dev.mjs land --apply                         # open the PR, or rebase + fast-forward + push
node _dev-workflow/scripts/dev.mjs sync                                 # dry run: report state drift
node _dev-workflow/scripts/dev.mjs sync --apply --since 14d             # apply it, over a 14-day window
node _dev-workflow/scripts/dev.mjs sync --deep                          # also read commit subjects
node _dev-workflow/scripts/dev.mjs version                              # installed vs latest, and files you have edited
node _dev-workflow/scripts/dev.mjs version --upgrade                    # run the installer to bring the payload up to date
```

`update` writes to the issue tracker; `version` reports on — and optionally updates — the workflow's
own files. They are named a word apart on purpose: `upgrade` would have sat one letter from `update`
in the same command table, and a mistyped verb that rewrites 25 files instead of moving a ticket is
not a mistake worth making possible.

`config`, `fetch`, `update` and `create` are plain HTTP. `start`, `land` and `sync` additionally
drive `git` and the GitHub CLI. None of them depend on anything outside Node's standard library, which is what lets
`_dev-workflow/` sit in a project of any language with nothing to install.

Two behaviours worth knowing, both learned the hard way against the real API:

- The commands API returns **200 for commands it did not apply**. `dev.mjs update` always reads
  the state back afterwards and prints what it actually found — trust that line, not the exit code.
- In a command query, only values *containing a space* may be braced — braces mark where a
  multi-word value ends, they are not general quoting. Both directions bite: `Type {Bug} Priority
  {X}` parses as the single value `{Bug} Priority` and 400s, and `State {Staging}` is rejected
  outright with `expected: {Staging}`. Brace `{In Review}`, never `{Staging}`.

## Keeping states honest

Transitions rot. A PR merges on a Friday, nobody is in a session, and the ticket sits in review
until someone notices. The usual fix is a webhook that fires on merge — but an event that fires
while the runner is down is simply lost, and the ticket is wrong forever.

`dev.mjs sync` reconciles instead of reacting. It asks *given the PRs that exist right now, where
should each ticket be?* and advances whatever has fallen behind:

| Evidence | Target |
| --- | --- |
| an open PR references the issue | `states.review` |
| a merged PR references the issue | `states.done` |

It only moves tickets **forward** along `states.ladder`, and leaves anything off the ladder alone —
a ticket parked in `Blocked` or `Won't Fix` was put there on purpose. Running it twice is a no-op,
so it is safe from a hook, a cron, or the top of `/dev-task`. Missing a week costs latency, nothing else.

It matches PRs to issues through the **branch name and PR title**. `--deep` additionally reads each
unmatched PR's commit subjects, which is where a `type(scope): description (ABC-1)` convention puts
the ID — slower, one extra API call per PR, but it finds work whose branch was named freehand.

Coverage is bounded by the convention, not the tool: a PR that names no issue anywhere is invisible
to it. If a run reports far fewer issues than you expect, that is the finding — the branch naming
has drifted, and the commit hook is what pulls it back.

Requires the [GitHub CLI](https://cli.github.com), authenticated. The repo is taken from
`repos[].github` when set, otherwise from the `upstream` then `origin` remote — set it explicitly
when branches live on a fork but PRs are opened against the parent.

## Verifying changes to this repo

The read paths (`dev-fetch`, `--dup-check`, `dev-config`, a `dev-sync` dry run) can be exercised
freely against any instance. The **write paths cannot be verified without writing once**, and a
dry run that looks perfect proves nothing about them — `dev-sync --apply` shipped with a command
the API rejects, and the dry run had reported the correct plan every time.

So: after changing anything that writes, run it once against a real issue. `dev.mjs create` on a
throwaway issue you then close, `dev.mjs update` / `dev.mjs sync --apply` on a ticket that genuinely
needs moving. Then re-run to confirm the operation is idempotent.

Never swallow stderr from a write. The first `--apply` failure printed only `update failed`,
which is worthless — the parser error underneath named the problem exactly.

`npm test` covers the rest: the hook's exit codes across 30 message shapes, the config merge, the
brace rule, and the reconciler's forward-only and off-ladder rules. The full release procedure is
the repo-local `/release` skill in `.claude/skills/`.

## What the skills refuse to do

These are deliberate, and worth preserving in any fork:

- `/dev-bug` files and stops. It never starts the fix, edits a file or switches branch — the session
  may be mid-task on something else.
- `/dev-task` does not touch a file before the plan is approved, and does not close a ticket unasked.
- `/dev-done` refuses to close a ticket whose acceptance criteria are unmet or whose suite fails, and
  reports the gap instead.
- Nothing bypasses git hooks. No `--no-verify`, no `HUSKY=0`. `lib/vcs.mjs` refuses to build the
  argv, so it holds for code added later too.
- Nothing force-resolves a merge conflict. `-X theirs` and `checkout --theirs` discard one side
  silently; a rebase conflict aborts, leaves the branch untouched, and says which commits clashed.
- Nothing writes outside `_dev-workflow/` and `.claude/skills/dev-*`. That includes your
  `.gitignore`: worktree mode prints the line to add rather than adding it.
