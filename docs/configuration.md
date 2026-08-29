# Configuration reference

`/dev-init` writes `.dev-workflow.json` at the repo root (`.claude/dev-workflow.json` also works).
The scripts walk up from `$CLAUDE_PROJECT_DIR` to find it, so it works from any subdirectory.

`.dev-workflow.json` holds no secret — `tokenOpRef` is a 1Password *reference* — so it is meant to
be committed.

Sections below are named after the config blocks themselves, so a key you are looking at in your
editor has a heading with the same name here.

- [The minimum](#the-minimum)
- [`language` — ticket prose](#language--ticket-prose)
- [`states` — the ladder](#states--the-ladder)
- [`branch` — names, worktrees](#branch--names-worktrees)
- [`commit` — the convention the hook enforces](#commit--the-convention-the-hook-enforces)
- [`delivery` — how work lands](#delivery--how-work-lands)
- [`repos` — more than one](#repos--more-than-one)
- [`stage` — greenfield or brownfield](#stage--greenfield-or-brownfield)
- [`metrics` — the transition log](#metrics--the-transition-log)
- [`hooks` — turning a shipped hook off](#hooks--turning-a-shipped-hook-off)
- [`docs` — the documentation set and decision records](#docs--the-documentation-set-and-decision-records)
- [`notesFile` — durable project knowledge](#notesfile--durable-project-knowledge)
- [Credentials (YouTrack)](#credentials-youtrack)
- [Environment overrides (YouTrack)](#environment-overrides-youtrack)
- [Every field at once](#every-field-at-once)

## The minimum

What is required depends on the tracker, so there is no single answer.

### YouTrack

```json
{
  "provider": "youtrack",
  "baseUrl": "https://acme.youtrack.cloud",
  "project": "ABC",
  "tokenOpRef": "op://Private/youtrack/credential",
  "states": { "start": "In Progress", "review": "In Review", "done": "Done" }
}
```

`baseUrl` and `project` are the only hard requirements; the wizard fills the rest from the
project's real field values. `tokenOpRef` is optional — without it the token comes from
`$YOUTRACK_TOKEN`.

### GitHub Issues

Authentication is the [GitHub CLI](https://cli.github.com) you already have — there is no token to
configure. The wizard asks which tracker the project uses before anything else and fills this in
from the repository: it proposes the slug from your `origin` remote and maps each ladder rung onto
a label the repository really carries. The ID shape follows `provider`, so there is nothing to
configure for `#123` to be recognised.

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
  }
}
```

GitHub has no state field, so the ladder is modelled with labels and `done` also closes the issue.
Three things follow, and the tool tells you about each rather than guessing:

- **The mapping is required.** Every rung except the first needs a label. The first rung —
  `Backlog` above — is what an issue carrying *no* ladder label means, which is why an explicit
  `states.ladder` is required for GitHub: without it, every untouched issue would read as
  in-progress.
- **Labels must already exist.** A missing one fails with the `gh label create` command to fix it;
  creating labels in a repository is a visible side effect, so it is not done for you.
- **`#123` is per-repository.** For a project spanning several repos, set `github.issuesRepo` to
  say which one holds the issues, or `#123` is ambiguous.

Closing an issue as *not planned* puts it off the ladder, so declined work is never reported as
shipped. Note that GitHub closes issues itself when a PR says `Fixes #12`, which means an issue can
reach *done* without ever passing through *review*.

## `language` — ticket prose

The language ticket *prose* is written in, regardless of the session's language. Code identifiers,
paths, endpoints and error messages always stay verbatim.

## `states` — the ladder

```json
"states": {
  "ladder": ["Backlog", "In Progress", "In Review", "Done"],
  "start": "In Progress",
  "review": "In Review",
  "done": "Done",
  "abandon": "Backlog"
}
```

`ladder` is the full list of states this project has. It exists to stop a session inventing one;
`start` / `review` / `done` are the three the skills actually apply. Many YouTrack projects have no
`Fixed` or `Closed` at all.

`abandon` is where `dev.mjs abandon` puts a ticket whose work is being thrown away, and it is the
one rung with **no default**. Everything else in the tool moves a ticket forward, so a wrong value
here is a mistake nothing else will notice or correct — and the ladder cannot supply one either: a
project that configures no `ladder` gets the derived `["In Progress", "In Review", "Done"]`, whose
first entry is where the ticket already is. Leave it unset and the verb says which key to add;
every other command is unaffected.

## `branch` — names, worktrees

```json
"branch": {
  "pattern": "<type>/<ID>-<slug>",
  "base": "main",
  "mode": "worktree",
  "worktreeDir": ".worktrees",
  "types": { "Bug": "fix", "Feature": "feat", "Task": "chore" },
  "fallbackType": "chore"
}
```

- **`pattern`** — `<type>`, `<ID>` and `<slug>`. A token the pattern omits is never rendered, so
  pinning `"<ID>-<slug>"` keeps the names this tool produced before branch types existed. Keep
  `<ID>` in it: `/dev-done` and `sync` both read the ticket back out of the branch.
- **`types`** — issue type → **commit** type, so a branch and the commits on it speak one
  vocabulary. Every value must be one of `commit.types`; a value outside it, or an issue type with
  no entry, is an error naming the key to add rather than a silent guess. An issue with no type at
  all uses `fallbackType`.
- **`mode`** — `worktree` (default) checks each ticket out in its own directory under
  `worktreeDir`, so starting a ticket never disturbs work in progress and `/dev-bug` can file
  against the running tree. `branch` switches this checkout in place and refuses when it is dirty.
  Add `.worktrees/` to your `.gitignore`: the installer writes only `_dev-workflow/` and
  `.claude/skills/dev-*`, and will not touch that file for you.

## `commit` — the convention the hook enforces

```json
"commit": {
  "pattern": "type(scope): description (<ID>)",
  "position": "suffix",
  "noTicketEscape": "chore(no-ticket)",
  "types": ["feat", "fix", "docs", "refactor", "test", "chore"],
  "enforce": true
}
```

- **`position`** — `suffix` (default), `prefix` or `any`. With `suffix`, a bare `ABC-1: …` prefix is
  rejected, matching how commitlint treats it; with `prefix`, the type is looked for *after* the ID.
  `enforce: false` turns the hook off entirely — as does `hooks.commitTicket: false`, the current
  spelling — and `requireType: false` keeps the issue-ID check but drops the conventional-commit
  one, for projects that do not use conventional commits.
- **`types` / `scopes`** — copy these from the project's own commitlint config; both the hook and
  the model read them.
- **`noTicketEscape`** — the subject prefix that means *this work genuinely has no issue*. The
  **scope** is what carries that meaning, not the type: with the default `chore(no-ticket)`, any
  configured type wearing that scope is accepted — `feat(no-ticket):`, `fix(no-ticket)!:` — so
  ticketless work is not forced to be a `chore`. That matters if you derive releases from commit
  types, since `chore` is the one type conventional-commits treats as non-releasing.

## `delivery` — how work lands

```json
"delivery": { "mode": "pr", "base": null, "remote": "origin", "push": true, "cleanup": true }
```

`pr` opens a pull request and lets `sync` move the ticket to the review state. `direct` rebases onto
the target, fast-forwards it, pushes, tears the worktree down and closes the ticket — which is what
a solo project wants. A rebase conflict aborts and reports; it is never force-resolved.
`push: false` lands locally and pushes nothing; `cleanup: false` keeps the worktree and branch after
landing.

`base` is the branch work is delivered **onto** — the branch `direct` fast-forwards, and the one a
pull request opens against. `null` means "the same branch it forked from", so leaving it alone keeps
the behaviour every project already had.

It is a different question from [`branch.base`](#branch--names-worktrees), which is where a
ticket branch is forked **from**, and the two only need separating when they genuinely differ:

```json
"branch":   { "base": "main" },
"delivery": { "mode": "pr", "base": "develop" }
```

That forks each ticket from `main` and opens its PR against `develop` — gitflow, or a release branch
that work must land on while a version is being cut. `dev.mjs config` prints the target whenever it
differs from the fork point, so the two are never silently confused, and `land` refuses a target
that exists neither locally nor on the remote rather than discovering it after pushing.

In `direct` mode the main checkout is switched to the target to merge and switched back afterwards,
so a worktree session never leaves the repo root sitting on a branch nobody selected.

## `repos` — more than one

Omit it entirely for a single-repo project.

```json
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
]
```

`when` is how `/dev-task` routes a ticket to a repo, `checks` is what `/dev-done` runs there, `env`
is prepended to every command in that repo, and `remotes` lists everywhere branches are pushed.

Commands taking `--repo` infer it from the directory they are run in, so the flag is only needed
from outside every repo. This is what makes worktree mode usable here: a worktree sits *under* the
repo it was cut from, and `--repo` accepts only the paths listed above — never the directory the
branch is actually in.
`repos[].delivery` overrides the top-level block, so one repo in a monorepo can push straight to
`main` while another needs a PR — or lands on a different branch entirely, since `base` is part of
that block like every other delivery field.

## `stage` — greenfield or brownfield

```json
"stage": "brownfield"
```

Settled once by a person, never inferred later. `dev.mjs assess` *proposes* a verdict and shows
every signal; a wrong stage would send `/dev-init` down the wrong branch with nothing downstream to
notice it, so it is confirmed rather than applied. Unset means nobody has decided, which is
different from either answer.

What it measures, and in what order:

| | Signal | Role |
| --- | --- | --- |
| **Decisive** | tracked source files, their total size, documentation size | is there already a system here? |
| Corroborating | commits, age, contributors | has it been worked on? |

The split is the rule, not an implementation detail. `git init` on a codebase somebody has been
building for years produces one commit, one author and an age of zero — so a verdict that weighted
those equally would call four hundred source files greenfield. History is evidence of activity,
never of code, and it is consulted only in the narrow band where there is a little code and it
could be either a generated scaffold or a young real project.

On a brownfield project it is what tells a session there is existing documentation worth reading
before starting work. `/dev-ingest-docs` turns that documentation into a verified map under
`_dev-workflow/artifacts/documentation/` — and never edits the documentation itself.

## `metrics` — the transition log

```json
"metrics": true,
"metricsFile": ".dev-workflow.metrics.jsonl"
```

Nothing in the workflow remembers how long anything took. This is the smallest thing that changes
that: one JSON line appended locally whenever a ticket reaches the **start**, **done** or
**abandon** rung. It is on by default, `"metrics": false` turns it off entirely, and it never
touches the network.

```json
{"at":"2026-08-27T09:00:00.000Z","event":"start","id":"#28","state":"In Progress","provider":"github"}
{"at":"2026-08-29T16:20:11.412Z","event":"done","id":"#28","state":"Done","provider":"github","elapsedMs":198011412,"starts":2,"criteria":"first-pass"}
```

- **`event`** is the rung, never a backend's state name, and it is read off the state the tracker
  reported *after* the write — the same rule everything else here follows. A move to a state the
  project has no rung for (parked in `Blocked`, moved by hand) is not recorded at all.
- **`elapsedMs`** runs from the first `start` of the current cycle. A ticket reopened after being
  closed starts a new one, so a fortnight of calendar time is not reported for two days of work.
  It is `null` — never `0` — when no local start was ever recorded, which is what closing somebody
  else's work through `sync` looks like.
- **`starts`** counts how many times the ticket entered the start rung in that cycle. It is named
  after what it measures: the log can see restarts, and cannot see how many times a test suite ran.
- **`criteria`** is the one thing the tool cannot observe. `/dev-done` passes
  `--criteria first-pass` or `--criteria reworked` on the close; with no flag the field is `null`,
  meaning nobody said, rather than `false`.

Abandoned tickets are recorded exactly like finished ones — a log that counts only successes
answers a question nobody asked.

> [!IMPORTANT]
> **Add it to your `.gitignore`.** Every developer appends to it, so a shared copy conflicts on
> every merge. The workflow says this once, the first time it creates the file, rather than editing
> your `.gitignore` — it writes only to `_dev-workflow/` and `.claude/skills/dev-*`.

Nothing may fail because of it. A log that cannot be written, or one a killed process left
half-written, produces a line on stderr and the ticket still moves: an instrument that breaks what
it measures is worse than no instrument.

## The update banner

Nothing to configure — this one is on, and the only settings are two ways to turn it off.

`dev.mjs config`, `status` and `standup` are the commands a skill runs at its top, so once a day
one of them prints a single line on **stderr** when the version installed in this project is behind
the one published to npm:

```
An update is available: 1.6.2 → 1.6.3 — npx claude-dev-workflow@latest --update
```

It is the same sentence and the same command `dev.mjs version` prints, deliberately: one phrasing,
one upgrade command, and `@latest` is the spelling that actually re-resolves rather than re-running
whatever `npx` cached first.

It stays quiet when there is nothing to say — when the versions match, when the install is *ahead*
of the registry (what a `github:` install tracking `main` looks like), and when there is no manifest
to compare against. It is silent on the second and third command of a session too: the answer is
cached, so a `/dev-task` that runs all three prints one line, not three.

**The check may never fail the command it rides on.** Offline, a registry that answers 500, an
unparseable body, a cache file something corrupted, a `_config/` that cannot be written — each means
no banner and nothing else. The host command's stdout, its exit code and everything else on its
stderr are exactly what they would have been. This is the rule the metrics log follows, for the same
reason.

### The cache

`_dev-workflow/_config/updatecheck.json`, holding the last version seen and when it was read. Fresh
(under 24 hours old) means no network call at all; stale means one lookup, bounded at 2.5 seconds,
written back.

> [!IMPORTANT]
> **Add it to your `.gitignore`.** You commit `_dev-workflow/`, and a file that rewrites itself
> daily would leave that directory permanently dirty — which destroys the drift signal
> `git diff _dev-workflow/` is there to give you. The workflow cannot add the line itself: it writes
> only to `_dev-workflow/` and `.claude/skills/dev-*`, and your `.gitignore` is neither.
>
> ```gitignore
> _dev-workflow/_config/updatecheck.json
> ```

### Turning it off

| Variable | Effect |
|---|---|
| `DEV_WORKFLOW_NO_NETWORK` | No lookup. A fresh cache is still read, so a banner already paid for still prints; nothing goes to the network. Also honoured by `dev.mjs version`, alongside its `--offline` flag. |
| `DEV_WORKFLOW_NO_BANNER` | No banner, and no lookup on its behalf. `dev.mjs version` still reports normally — asking is the whole point of that command. |

Set either in your shell profile, or per command:

```bash
DEV_WORKFLOW_NO_BANNER=1 node _dev-workflow/scripts/dev.mjs config
```

## `hooks` — turning a shipped hook off

Three hooks are installed and on by default. One key each turns one off.

```jsonc
{
  "hooks": {
    "sessionStart": true,   // false: no standup when a session opens
    "commitTicket": true,   // false: commit messages are not checked
    "adrImmutable": true    // false: accepted decision records are editable
  }
}
```

The hooks read this themselves rather than the installer honouring it, and that is the point: an
opt-out that worked by deleting the entry from `.claude/settings.json` would last until the next
`npx claude-dev-workflow@latest`, which re-adds anything missing.

`commit.enforce` and `docs.enforce` are the older spellings for the last two, and both still work.
`false` in either place turns the hook off; the older key can only disable, never re-enable, so a
config carrying both never has to be read for precedence.

### What each one costs to leave on

| Hook | Fires | Cost |
|---|---|---|
| `sessionStart` | once, when a session opens | a `standup` run, bounded at 3s, plus its output in the session's context |
| `commitTicket` | every Bash tool call | ~3ms for anything that is not a `git commit -m` |
| `adrImmutable` | every `Edit`/`Write` | one filename check, and a file read only for ADR-shaped paths |

`sessionStart` is the one with a real price. Its output goes into the session's context as well as
the terminal, so it is spending tokens on every session, not just screen space. That buys a board
you did not have to ask for — what merged, what is checked out, what stopped moving, what is still
open on the tracker, and the one thing waiting on you — and it is on by default because a report
nobody switches on reports nothing.
If a project's report is long enough that the trade stops paying, turn it off here and run
`/dev-standup` when you want it.

It stays silent, rather than reporting an error, when there is nothing useful to say: no
`.dev-workflow.json` (so `/dev-init` has not been run), an unreadable one, or a `standup` that
failed. It never blocks a session, and past 3s it prints a single line and gives up.

Compaction does not re-trigger it. `SessionStart` fires again on compaction, and reprinting the
board every time would spend context on a report nobody asked for twice.


## `docs` — the documentation set and decision records

Where `/dev-docs-init` writes a greenfield project's documentation, which documents it writes, where
`/dev-adr` keeps decision records, and whether the immutability hook applies.

```jsonc
{
  "docs": {
    "dir": "docs",                     // where the documentation set lives
    "set": ["architecture", "domain", "operations", "testing", "security"],
    "decisionsDir": "docs/decisions",  // relative to the project root
    "enforce": true                    // false disables check-adr-immutable.sh
                                       // (hooks.adrImmutable is the current spelling)
  }
}
```

### `set` is an array, and that matters

`deepMerge` merges objects recursively and **replaces arrays outright** — the same rule that lets
you narrow `commit.types` to three without inheriting the other eight. So listing three documents
gives you exactly three. Written as an object it would give you those three *plus* the five
defaults, silently, which is why an object here is refused rather than merged.

The keys and the filenames they map to:

| key | file | holds |
| --- | --- | --- |
| `architecture` | `docs/architecture.md` | components, boundaries, data flow |
| `domain` | `docs/domain.md` | the glossary — terms, and what they mean *here* |
| `operations` | `docs/operations.md` | the runbook: run it, deploy it, what breaks |
| `testing` | `docs/testing.md` | what is tested, how to run it, what deliberately is not |
| `security` | `docs/security-model.md` | trust boundaries, secrets, what is assumed |
| `decisions` | `docs.decisionsDir` | a **pointer** — `docs init` writes nothing here, it prints `/dev-adr` |

A key outside that list is an error naming the known ones, never a guess.

### Why the security document is `security-model.md`

`lib/ingest.mjs` excludes `/^security\.md$/i` from what counts as a document, and tests it against
the **basename**, before the `docs/` rule. That exclusion was written for a root-level GitHub
`SECURITY.md` policy file, but as written it also swallows a real security document under `docs/`:
`classifyPath('docs/security.md')` is `other`, while `classifyPath('docs/security-model.md')` is
`doc`. A set emitting the first name would produce a file `ingest scan` never inventories.

Narrowing that regex would change what `ingest scan` finds in every already-surveyed project and
reopen settled surveys, so the filename sidesteps it instead — and a test renames it back to
`security.md` and fails, so this cannot be undone by accident.

### `decisionsDir`

Unlike `github.labels`, `decisionsDir` has a default. The difference is what a wrong value costs: a
wrong label mapping fails silently — the ticket never moves — while a wrong directory is named in
the first `adr new`'s own output. A monorepo keeping records per package points this elsewhere, or
passes `--dir` for one run.

`dir` and `set` also have defaults, for the same reason and with one caveat: **an existing project's
`.dev-workflow.json` will not grow these keys on an update.** The installer's `--update` refreshes
the payload, not your config, so until [#39](https://github.com/ayhid/claude-dev-workflow/issues/39)
lands you will not see them written out — the feature works on the defaults, and what is lost is the
key's discoverability in your own file. Add them by hand to change either.

**[Documentation set reference →](documentation.md)** covers the claim format, what `docs check`
enforces, and how a hand-edited document gets absorbed rather than overwritten.

**[Decision records reference →](decisions.md)** covers the format, the supersede rule, the gap in
the hook's coverage, and reading records in Obsidian.


## `notesFile` — durable project knowledge

What a session learns dies with the session unless something writes it down. `dev.mjs note` appends
to a markdown file beside your config, tagged with the date and the ticket the work was under:

```bash
node _dev-workflow/scripts/dev.mjs note "the commit convention (#12) is a reference, not a closing keyword"
```

```markdown
## 2026-08-17 — #12

the commit convention (#12) is a reference, not a closing keyword
```

| Field | Default | What it does |
| --- | --- | --- |
| `notesFile` | `.dev-workflow.notes.md` | Where notes are appended, relative to the project root. |
| `notesMaxChars` | `4000` | How much of it `dev.mjs config` prints before it truncates. |
| `notes` | none | The older inline array. Still read, still printed first, never rewritten. |

Both sources are shown to the model on every `/dev-task`, `/dev-bug` and `/dev-done`, so a note is
context the next session starts with rather than something it has to be told.

The file is a **log, not a config**: entries are appended and never rewritten, so anything you edit
by hand survives. Commit it, the same as `.dev-workflow.json` — it holds no secret and it is worth
more to the next person than to you. When `dev.mjs config` truncates, it says how many entries it
left out and where to read them; it never drops one silently.

Notes about one ticket belong on that ticket instead, where they stay attached to the work:

```bash
node _dev-workflow/scripts/dev.mjs update ABC-22 comment "tried X, it deadlocks under load"
```

## Credentials (YouTrack)

A GitHub Issues project has no credentials to configure — it uses the GitHub CLI's own auth.

Token resolution order:

1. `$YOUTRACK_TOKEN`
2. 1Password, via `op read "<tokenOpRef>"`

The token is never written to disk and never appears in `argv`: it is passed as an `Authorization`
header on a `fetch` call, and `op read` is given the 1Password *reference* rather than the secret.
Subprocesses are spawned with argument arrays, never an interpolated shell string, so nothing
sensitive can surface in a process listing.

Create a token at *Profile → Account Security → Authentication → New token* with the `YouTrack`
scope.

## Environment overrides (YouTrack)

`YOUTRACK_BASE_URL`, `YOUTRACK_PROJECT`, `YOUTRACK_PROJECT_ID`, `YOUTRACK_TOKEN`,
`YOUTRACK_TOKEN_OP_REF`, `YOUTRACK_LANGUAGE` and `YOUTRACK_CONFIG_DIR` all override the config file.
Useful for one-off runs against another instance, and for CI. There is no GitHub equivalent.

## Every field at once

<details>
<summary>A config using every key, for copy-paste</summary>

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
    "abandon": null,
    "ladder": []
  },
  "branch": {
    "pattern": "<type>/<ID>-<slug>",
    "base": "main",
    "mode": "worktree",
    "worktreeDir": ".worktrees",
    "types": { "Bug": "fix", "Feature": "feat", "Task": "chore" },
    "fallbackType": "chore"
  },
  "delivery": { "mode": "pr", "base": null, "remote": "origin", "push": true, "cleanup": true },
  "commit": {
    "pattern": "type(scope): description (<ID>)",
    "position": "suffix",
    "noTicketEscape": "chore(no-ticket)",
    "types": ["feat", "fix", "docs", "refactor", "test", "chore"],
    "enforce": true
  },
  "hooks": { "sessionStart": true, "commitTicket": true, "adrImmutable": true },
  "priorities": ["Show-stopper", "Critical", "Major", "Normal", "Minor"],
  "defaultPriority": "Normal",
  "reviewer": "octocat",
  "stage": "brownfield",
  "docs": {
    "dir": "docs",
    "set": ["architecture", "domain", "operations", "testing", "security"],
    "decisionsDir": "docs/decisions",
    "enforce": true
  },
  "metrics": true,
  "metricsFile": ".dev-workflow.metrics.jsonl",
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
  "notes": ["Anything a future session must know that the code does not say."],
  "notesFile": ".dev-workflow.notes.md",
  "notesMaxChars": 4000
}
```

</details>

Two worked examples live in [`examples/`](../examples/): a plain single-repo project, and a two-repo
project with a long state ladder, non-English tickets and per-repo toolchains.
