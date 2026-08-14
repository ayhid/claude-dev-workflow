---
name: yt-init
description: Set up the YouTrack workflow in this project — probe the repo, confirm the instance, project, language, state ladder and check commands with the user, and write .youtrack.json. Use when /task, /bug or /done reports missing config, or when the user types /yt-init.
argument-hint: [optional YouTrack URL or project key]
---

# /yt-init — configure the YouTrack workflow for this project

Produces one file, `.youtrack.json` at the repo root. Everything `/task`, `/bug` and `/done`
need that is project-specific lives there; nothing else in this plugin is edited per project.

There is also a non-interactive-model path to the same file: `npx youtrack-workflow` runs a CLI
wizard that does this deterministically, including reading the project's real state names off the
API. If the user would rather click through prompts than converse, point them at it and stop.

## 1. Check what already exists

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/yt.mjs" config
```

If a config file is already reported, show it and ask whether to amend or replace it. Never
overwrite an existing `.youtrack.json` without saying what will change.

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
  subjects on this project, which beats any assumption about prefix vs suffix.

## 3. Ask only what the repo cannot tell you

In one batch:

1. **YouTrack instance URL** and **project key** (the short prefix in issue IDs, e.g. `RMB`).
2. **Token source** — `$YOUTRACK_TOKEN`, or a 1Password ref (`op://Vault/item/credential`).
   Never ask them to paste the token itself.
3. **Language for ticket prose** — the language issues are written in, which is often not the
   language the session is conducted in. Default to English if they have no preference.
4. **State ladder** — the states this project moves through, and specifically which one means
   *started*, which means *in review*, and which means *finished*. YouTrack projects differ
   wildly here; some have no `Fixed`/`Closed` at all.
5. **Reviewer** to request on pull requests, if there is a habitual one.

## 4. Verify the credentials before writing anything

Once you have the URL, project and token source, prove they work:

```bash
YOUTRACK_BASE_URL=<url> YOUTRACK_PROJECT=<key> \
  node "${CLAUDE_PLUGIN_ROOT}/scripts/yt.mjs" create --dup-check "test"
```

A `no open issues matched` line or a list of issues both mean success. An auth or project error
means the config is wrong — fix it now rather than writing a file that fails on first use.

To confirm the state names, fetch any real issue from the project with `yt.mjs fetch` and read the
`State` line. Do not invent state names; a `State X` command YouTrack does not recognise returns
400, or worse, 200 without applying.

## 5. Write `.youtrack.json`

Full shape — omit anything that does not apply, every field except `baseUrl` and `project` has
a working default:

```json
{
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

  "branch": { "pattern": "<ID>-<slug>", "base": "main" },

  "commit": {
    "pattern": "type(scope): description (<ID>)",
    "position": "suffix",
    "noTicketEscape": "chore(no-ticket)",
    "types": ["feat", "fix", "docs", "refactor", "test", "chore"],
    "scopes": ["api", "ui", "config"],
    "enforce": true,
    "requireType": true
  },

  "issueTypes": ["Bug", "Feature", "Task", "Epic", "Improvement"],
  "priorities": ["Show-stopper", "Critical", "Major", "Normal", "Minor"],
  "defaultPriority": "Normal",
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

  "notes": [
    "Anything a future session must know that the code does not say."
  ]
}
```

Field notes:

- `states.ladder` is documentation for the model — it stops a session from inventing a state that
  does not exist. `start` / `review` / `done` are the three transitions the skills actually apply.
- `commit.position` is `suffix`, `prefix` or `any`, and the commit hook enforces it.
  `commit.enforce: false` disables the hook entirely; `commit.requireType: false` keeps the
  issue-ID check but drops the conventional-commit one, for projects without that convention.
- `commit.types` and `commit.scopes` should be **copied from the project's commitlint config**, not
  guessed — the hook and the model both read them.
- `repos` empty (or absent) means a single repo at the project root. With entries, `when`
  is the routing rule `/task` uses to pick a repo and `checks` is what `/done` runs there.
- `env` is prepended to every command run in that repo. Use it for pins the version manager
  cannot resolve on its own.
- `notes` is free-form and is shown to the model on every `/task`, `/bug` and `/done`.

## 6. Install the plugin's own dependencies

Claude Code installs a plugin by cloning it and never runs `npm install`, so do it once here:

```bash
npm install --omit=dev --no-audit --no-fund --prefix "${CLAUDE_PLUGIN_ROOT}"
```

Only `yt.mjs sync` needs this (it drives the GitHub CLI through zx); `config`, `fetch`, `update`
and `create` work without it. If the install fails — no network, a read-only directory — say so
and carry on: `sync` will retry it on first use, and everything else is unaffected. A plugin
**upgrade** lands in a fresh directory, so this runs again after each one.

## 7. Confirm it loads, and tell them what is next

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/yt.mjs" config
```

Read the summary back and check it matches what was agreed. Then:

- Suggest committing `.youtrack.json` — it holds no secret, only a 1Password *reference*.
- If they chose `$YOUTRACK_TOKEN` over 1Password, remind them it must be exported in the shell
  Claude Code runs in, and must not be committed.
- Point at `/task <ID>` as the entry point.
