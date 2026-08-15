# claude-dev-workflow

Ticket-driven development against an issue tracker — YouTrack or GitHub Issues — installed **per
project** as Claude Code skills. This file is for working **on** it; `README.md` documents using it.

## Three surfaces, three sets of constraints

| Surface | Runs | Constraint |
|---|---|---|
| `bin/*` | once, at install, from the npx checkout | Node ≥22. May use dependencies freely. |
| `lib/*`, `scripts/*` | on every skill invocation, from the installed copy | **Zero dependencies** — node: builtins only. |
| `hooks/check-commit-ticket.sh` | **on every Bash tool call** | Bash + jq only. Latency-critical — keep the fast-bail first. |

The zero-dependency rule for `lib/` and `scripts/` is load-bearing, not an aesthetic: the payload
is copied into the user's project as plain source with no `node_modules`, so it has to work in a
Python or Rust repo. Anything you `import` there must come from `node:`.

The hook stays bash on purpose: `PreToolUse` with `matcher: "Bash"` fires on every command, so its
non-commit exit path must cost ~3ms, not a ~50ms Node boot.

## Distribution: one path

`npx claude-dev-workflow@latest` copies `lib/`, `scripts/` and `hooks/` into the project's
`_dev-workflow/`, the skills into `.claude/skills/dev-*`, and merges the commit hook into
`.claude/settings.json`. Nothing is installed globally; there is no plugin manifest.
`npx github:ayhid/claude-dev-workflow` is the same install straight off `main`, one release ahead.

**Always write `@latest`, everywhere — docs, help text, printed hints.** npx keys its cache on the
literal spec string and, on a re-run, only checks whether the tree it already cached satisfies the
range it recorded there (`2.0.0` satisfies the `^2.0.0` it wrote). A bare `npx claude-dev-workflow`
therefore re-runs the first version it ever saw, forever; `latest` is a dist-tag, so it is
re-resolved. The `github:` form has no version to compare at all — bust it by changing the spec
(`#v2.1.0`, a sha), not by clearing the cache. `tests/updatecheck.test.mjs` fails if the two places
that print the command drift.

**Updating must never route through the wizard.** `bin/install.mjs --update` runs `installPayload`
and exits *before the first prompt*, deliberately: the wizard is YouTrack-only and its instance URL
is mandatory, so a GitHub Issues project could not answer it. It also makes the installer usable
with no TTY. Adding a prompt above that early exit silently removes both properties.

`bin/lib/payload.mjs` owns that, and records a sha256 per file in
`_dev-workflow/_config/manifest.json`. That manifest is what makes a re-run an *update*: unchanged
files are replaced, files the user edited are reported and left alone, files no longer shipped are
removed. Never overwrite a user's edit silently, and never overwrite `.claude/settings.json`
wholesale — merge into it, since users have their own hooks there.

`main` is the distribution channel. A broken commit ships immediately.

## Adding an issue-tracker backend

`lib/provider.mjs` is the contract: an **Adapter** per backend, a `makeProvider` **Factory**, and a
`capabilities` record. Callers branch on capabilities, never on `provider.name` — a name check is a
place a future backend has to be taught about, which is exactly what the layer exists to prevent.

A new backend is one file in `lib/`, one `case` in the factory, and a passing run of
`tests/provider.contract.mjs` **unchanged**. If the core needs changing to accommodate a backend,
the abstraction is wrong: fix it in `provider.mjs` rather than special-casing a command.

Four rules the contract enforces, not conventions to remember:

1. **IO is injected.** An adapter takes its transport (`fetch`, or a command runner) as an
   argument. That is what makes every adapter testable offline, and it is why the YouTrack tests no
   longer monkey-patch `globalThis.fetch`.
2. **No inference.** Every mapping comes from config. A missing one is an error naming the key to
   add. A guess that is usually right is worse than an error, because the times it is wrong are
   silent — `github.labels` is required for this reason.
3. **Writes read back.** Report the state found afterwards, never the one requested, and converge
   on a repeat. YouTrack made this necessary; it is the contract for everyone.
4. **Output is stable.** Sorted, rendered, ISO-8601. The same inputs print the same bytes.

Rung resolution belongs to the adapter (`setState` takes `start`/`review`/`done`), not the caller.
Leaving it to callers makes rule 2 advisory.

## YouTrack API invariants — learned the hard way, do not regress

1. **The commands API returns 200 for commands it did not apply.** Always read the state back and
   report what you actually found. The exit code proves nothing.
2. **Only values containing a space may be braced.** Braces mark where a multi-word value ends;
   they are not quoting. `State {In Review}` is correct, `State {Staging}` is rejected outright,
   and `Type {Bug} Priority {X}` parses as the single value `{Bug} Priority` and 400s.
3. **A dry run proves nothing about a write path.** `dev-sync --apply` once shipped with a command
   the API rejected while every dry run reported the correct plan. Exercise writes for real.
4. **Never swallow stderr from a write.** The first `--apply` failure printed only `update failed`;
   the parser error underneath named the problem exactly.

## Git operations — invariants, not preferences

`lib/branch.mjs` decides what things are called; `lib/vcs.mjs` runs the commands, with its runner
injected like every adapter. Keeping them apart is what makes the naming rules testable without a
repository and the git rules testable without a network.

1. **The choke point enforces the refusals.** Every git call goes through one `git()` wrapper that
   refuses `--no-verify` and every spelling of `-X theirs` / `--theirs`. Put the check there, not at
   call sites: a reviewer should not have to notice a hook bypass in a new call site later.
2. **A conflict is reported, never resolved.** A failed rebase aborts and leaves the branch exactly
   as it was found. `-X theirs` makes a conflict disappear by discarding somebody's work, and it is
   silent about which.
3. **Worktree teardown has three tiers.** `remove` → `remove --force` → confined `rm` + `prune`. A
   process the session left running recreates a cache file, the plain remove fails with ENOTEMPTY,
   and by then git may have dropped its admin entry so `--force` fails differently. The manual tier
   must refuse any path resolving outside the configured `worktreeDir`: `rm` validates nothing.
4. **Worktree mode changes the working directory, and that is the whole failure mode.** The repo
   root stays on the base branch. A command run there edits the wrong checkout, reports a clean
   tree, and reads as "nothing was done". `dev.mjs start` prints `cd <path>` as its last line for
   this reason.
5. **Branch names round-trip.** `sync` and `/dev-done` read the ticket back out of the branch, so
   `renderBranch` and `issueIdFromBranch` are two halves of one rule. GitHub IDs lose the `#` in a
   ref and regain it on the way out — scanning a branch with the prose ID syntax is why `/dev-done`
   never worked on a GitHub project.
6. **One vocabulary for branches and commits.** `branch.types` maps an issue type onto a
   *commit* type, and a value outside `commit.types` is refused. Two lists would drift, and the
   branch saying `feature/` while its commits must say `feat` is exactly that drift.

## Security properties to preserve

- The token is never written to disk and never appears in `argv`. Pass it in a `fetch` header;
  shell out with `execFile`-style argument arrays, never an interpolated shell string.
- `.dev-workflow.json` holds no secret — `tokenOpRef` is a 1Password *reference* — and is meant to be
  committed by consumers.

## Layout

- `lib/`, `scripts/`, `hooks/`, `skills/` — **copied into user projects.** Adding a file here
  ships it; `bin/lib/payload.mjs` picks these up wholesale, so nothing repo-specific may live in
  them.
- `bin/` — the installer. Runs from the npx checkout only, never from a user's project.
- `docs/` — user-facing reference, listed in `package.json` `files` so it ships in the tarball.
  Never copied into a project: `planFiles` reads `lib/`, `scripts/`, `hooks/` and `skills/` only.
  `README.md` links into it, so a heading rename there breaks a link here.
- `CONTRIBUTING.md` — how to verify a write path, for outside contributors. Repo-local; this file
  stays the architecture document.
- `tests/`, `.github/`, `.husky/`, `commitlint.config.mjs`, `release.config.mjs` — repo-local
  development only. Never referenced at runtime, never copied into a project. The
  `devDependencies` they pull in are the *only* dependencies this repo may grow; `lib/` and
  `scripts/` stay on `node:` builtins, and `tests/version.test.mjs` fails if they do not.
- `_dev-workflow/`, `.claude/skills/dev-*`, `.dev-workflow.json` — **installer output, not source.**
  See "This repo is one of its own consumers" below. `.claude/` otherwise holds repo-local
  development config: `settings.json`, its hooks, and the `release` / `workflow-audit` skills.
- Enforcement belongs in `hooks/`; repeatable procedure belongs in a skill; only always-true
  conventions belong in this file.

Skill names are namespaced `dev-*`. They live in a flat namespace next to every other skill the
user has installed, and `task` / `bug` / `done` are far too generic to claim.

## What we own in a user's project, and nothing else

A project is shared ground — other skill-based tools install their own payload directories and
their own skills alongside ours. We write to exactly two roots:

- `_dev-workflow/**`
- `.claude/skills/dev-*/**`

`isOwnedPath` in `bin/lib/payload.mjs` is that boundary, and **every write and every delete goes
through it** — including the removal pass, so a hand-edited or corrupted manifest still cannot
reach a file that is not ours. A planned write outside those roots is a hard error, not a warning.

The manifest is split along that line, and the split is the point. **Reading** it —
`lib/manifest.mjs` — ships, because `dev.mjs version` reports the installed version and local drift
from the same file the installer wrote; two independent readers of one schema is the drift this repo
refuses everywhere else. **Writing** it — `planFiles`, `isOwnedPath`, `installPayload`, the delete
pass — stays in `bin/` and is never copied into a project, so the boundary has exactly one
implementation. `dev.mjs version --upgrade` therefore *spawns the installer* rather than writing
anything itself. A writer inside the payload would be a second copy of that rule, which is precisely
what it exists to prevent.

`.claude/settings.json` is the one genuinely shared file. It is **merged, never rewritten**: the
user's own hooks survive, and our entry is matched by command string so a re-run does not
duplicate it.

Depend on nothing from any other tool, and assume nothing about its layout. Interoperation here
means staying out of the way, not integrating.

## Checks

```bash
npm test        # lint + unit tests + hook table test
npm run lint    # bash -n, node --check, shellcheck when installed
```

## This repo is one of its own consumers

The workflow is **installed into this repo**, against GitHub Issues on `ayhid/claude-dev-workflow`.
`.dev-workflow.json` is the config, `_dev-workflow/` is the installed runtime, and
`.claude/skills/dev-*` are the installed skills — all committed, and all produced by
`bin/lib/payload.mjs` exactly as a user's would be.

Two consequences, both deliberate:

- **`_dev-workflow/` is a copy, not a source.** Edit `lib/`, `scripts/` and `hooks/` at the root,
  then re-run the installer to refresh it. Editing the copy makes the manifest treat it as a
  user edit and the next install will skip it — silently preserving a change that is not in the
  shipped source. `git diff` on `_dev-workflow/` after an install is how drift becomes visible.
- **The commit hook runs from the installed copy.** `.claude/settings.json` registers
  `_dev-workflow/hooks/check-commit-ticket.sh`, not the source-tree one, so the path a user
  actually gets is the path enforced here. That registration is the only thing making the guard
  apply — removing the entry silently removes the enforcement.

Work with an issue behind it references it as `(#123)`. Work without one keeps the
`<type>(no-ticket):` escape hatch; the type in it is incidental, so any configured type carries it.

`hooks/check-commit-ticket.sh` only sees `git commit -m` issued through the agent; it defers on
editor commits, `-F` files and amends. Husky's `commit-msg` hook is what covers those, running
`commitlint`. The two split the job — commitlint owns the conventional-commit *shape*, the hook owns
the *issue reference* — and `tests/commitlint.test.mjs` fails if their type lists ever drift apart.

## Releasing

**`semantic-release` cuts the release automatically on every push to `main`**, gated on both CI jobs
passing. There is no manual version bump; `.claude/skills/release/SKILL.md` is now the pre-push
checklist, not the procedure.

The consequence is that **the commit type is a release decision, not a label**: `feat` cuts a minor,
`fix` a patch, `!` a major, and everything else ships nothing. Choose it accordingly — the escape
hatch takes any type precisely so ticketless work is not forced to be a non-releasing `chore`.

The version is written back to `package.json` on `main` by `@semantic-release/git`, because `main` is
the distribution channel for the `github:` install path and `bin/lib/payload.mjs` stamps that version
into each project's manifest. A release that only bumps the npm tarball leaves every `github:`
install reporting a stale version forever.
