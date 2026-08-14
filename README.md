# youtrack-workflow

A Claude Code plugin for ticket-driven development against [YouTrack](https://www.jetbrains.com/youtrack/).
Four skills wrap the whole loop, and nothing in the plugin is project-specific — instance,
project, ticket language, repo layout, state ladder and commit convention all come from one
`.youtrack.json` per project.

| Skill      | What it does |
| ---------- | ------------ |
| `/yt-init` | Probes the repo, asks what it cannot infer, verifies the credentials, writes `.youtrack.json`. |
| `/task ID` | Fetches the issue, agrees acceptance criteria, plans, moves it to *in progress*, branches, implements with ticket-referencing commits. |
| `/bug`     | Investigates the likely code path, checks for duplicates, drafts the issue in the project's language, files it on approval. **Never fixes.** |
| `/done`    | Re-reads the ticket, verifies each criterion with evidence, runs the checks, closes on confirmation. |

A `PreToolUse` hook blocks any `git commit -m` whose subject does not match the configured
convention, with a per-project escape hatch for genuinely ticketless work.

## Install

From the project you want to set up:

```bash
npx youtrack-workflow
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
6. writes `.youtrack.json` and offers to register the plugin with Claude Code.

It works offline too — if the API is unreachable it says so and falls back to typed answers.

```
npx youtrack-workflow --dir ../other-project   # target somewhere else
npx youtrack-workflow --print                  # show the config, write nothing
npx youtrack-workflow --force                  # overwrite without the confirm step
```

### Manual install

```bash
/plugin marketplace add <this repo's URL or local path>
/plugin install youtrack-workflow@youtrack-workflow-marketplace
```

Then run `/yt-init` in each project — the same setup, driven by the model rather than the CLI.

Requirements: Node ≥ 18 for the installer; `bash`, `curl` and `jq` for the skills at runtime.
The 1Password CLI (`op`) is optional.

## Configuration

`/yt-init` writes `.youtrack.json` at the repo root (`.claude/youtrack.json` also works). The
scripts walk up from `$CLAUDE_PROJECT_DIR` to find it, so it works from any subdirectory.

Only `baseUrl` and `project` are required — everything else has a working default.

```json
{
  "baseUrl": "https://acme.youtrack.cloud",
  "project": "ABC",
  "tokenOpRef": "op://Private/youtrack/credential",
  "language": "English",
  "states": { "start": "In Progress", "review": "In Review", "done": "Done", "ladder": [] },
  "branch": { "pattern": "<ID>-<slug>", "base": "main" },
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
      "scopes": ["feature", "bug", "components"]
    }
  ],
  "notes": ["Anything a future session must know that the code does not say."]
}
```

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
- **`repos`** — omit for a single-repo project. With entries, `when` is how `/task` routes a
  ticket to a repo, `checks` is what `/done` runs there, `env` is prepended to every command in
  that repo, and `remotes` lists everywhere branches are pushed.

`.youtrack.json` holds no secret — `tokenOpRef` is a 1Password *reference* — so it is meant to
be committed.

Two worked examples live in [`examples/`](examples/): a plain single-repo project, and a
two-repo project with a long state ladder, non-English tickets and per-repo toolchains.

## Credentials

Token resolution order:

1. `$YOUTRACK_TOKEN`
2. 1Password, via `op read "<tokenOpRef>"`

The token is never written to disk and never appears in `argv` — `curl` reads the `Authorization`
header from stdin via `-K -`.

Create a token at *Profile → Account Security → Authentication → New token* with the `YouTrack`
scope.

## Environment overrides

`YOUTRACK_BASE_URL`, `YOUTRACK_PROJECT`, `YOUTRACK_PROJECT_ID`, `YOUTRACK_TOKEN`,
`YOUTRACK_TOKEN_OP_REF`, `YOUTRACK_LANGUAGE` and `YOUTRACK_CONFIG_DIR` all override the config
file. Useful for one-off runs against another instance, and for CI.

## Scripts

They are ordinary CLI tools; the skills just call them.

```bash
scripts/yt-config.sh [--json]                       # effective config
scripts/yt-fetch.sh  ABC-22                         # issue as markdown, comments included
scripts/yt-update.sh ABC-22 "State In Progress"     # apply a command, read the state back
scripts/yt-update.sh ABC-22 "State Done" @/tmp/c.md # …with a comment (literal or @file)
scripts/yt-update.sh ABC-22 comment "note"          # comment only
scripts/yt-create.sh --dup-check "slug 500 router"  # open issues matching keywords
scripts/yt-create.sh "Summary" @/tmp/body.md Bug Major   # prints the new ID on stdout
```

Two behaviours worth knowing, both learned the hard way against the real API:

- The commands API returns **200 for commands it did not apply**. `yt-update.sh` always reads
  the state back afterwards and prints what it actually found — trust that line, not the exit code.
- In a command query, only values *containing a space* may be braced. `Type {Bug} Priority {X}`
  parses as the single value `{Bug} Priority` and 400s.

## What the skills refuse to do

These are deliberate, and worth preserving in any fork:

- `/bug` files and stops. It never starts the fix, edits a file or switches branch — the session
  may be mid-task on something else.
- `/task` does not touch a file before the plan is approved, and does not close a ticket unasked.
- `/done` refuses to close a ticket whose acceptance criteria are unmet or whose suite fails, and
  reports the gap instead.
- Nothing bypasses git hooks. No `--no-verify`, no `HUSKY=0`.
