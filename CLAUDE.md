# claude-dev-workflow

Ticket-driven development against an issue tracker — YouTrack or GitHub Issues — installed **per
project** as Claude Code skills. This file is for working **on** it; `README.md` documents using it.

## Three surfaces, three sets of constraints

| Surface | Runs | Constraint |
|---|---|---|
| `bin/*` | once, at install, from the npx checkout | Node ≥22. May use dependencies freely. |
| `lib/*`, `scripts/*` | on every skill invocation, from the installed copy | **Zero dependencies** — node: builtins only. |
| `hooks/check-commit-ticket.sh` | **on every Bash tool call** | Bash + jq only. Latency-critical — keep the fast-bail first. |
| `hooks/check-adr-immutable.sh` | on every `Edit`/`Write` | Bash + jq only. Off the hot path, so it may read the target. |
| `hooks/session-standup.mjs` | **once, when a session opens** | Node, zero deps. Bounded at 3s; may never fail or stall a session. |

The zero-dependency rule for `lib/` and `scripts/` is load-bearing, not an aesthetic: the payload
is copied into the user's project as plain source with no `node_modules`, so it has to work in a
Python or Rust repo. Anything you `import` there must come from `node:`.

The commit hook stays bash on purpose: `PreToolUse` with `matcher: "Bash"` fires on every command, so
its non-commit exit path must cost ~3ms, not a ~50ms Node boot.

`session-standup.mjs` is the **bounded exception**, and it is one for two reasons rather than
preference. `SessionStart` fires once per session, so the ~3ms budget the bash rule protects simply
does not apply. And the hook has to bound its own runtime: `timeout(1)` is not on a stock macOS —
that is `gtimeout`, from coreutils — so a bash wrapper could not keep the 3s promise portably, while
`spawnSync`'s `timeout` can. The zero-dependency rule still binds it in full; it runs from the
installed copy in someone else's Python or Rust repo. A *third* Node hook needs this argument made
again from scratch, not cited.

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

**Updating has two modes, and only one of them may reach the wizard.** `--update` is *express*:
`installPayload`, and out before the wizard's first question. `--update --reconfigure` is *change
config*: the same refresh, then the whole wizard with the current values as defaults — the mode
that used to exist only as the bare command, where nothing named it and nobody found it.

Express is the mode with the invariants. Two properties depend on it: updating must not mean
re-answering twenty questions to change nothing but the version, and the installer must work where
there is no TTY at all — CI, a container, a pipe. A wizard question added above that early exit
silently removes both, and `tests/install.test.mjs` spawns `--update` with stdin closed to prove
one has not been. (The reason used to be that the wizard was YouTrack-only and its instance URL
mandatory; the wizard now asks which tracker first and configures either, but the rule outlived its
original justification.)

**Express may add a config key, and may do nothing else to the config.** A version that introduces
a key used to leave every updated project without it, silently and for ever. `bin/lib/config-keys.mjs`
is the registry that makes the question answerable at all — key, default, and the prompt for it —
because `buildConfig` knows only whole configs. Absent means *never answered*, so asking is not
re-asking; with no TTY nothing is asked, the default is written, and the added keys are printed so
the choice is visible in the log. Only ever **added**: a key already in the file is never rewritten,
reordered or removed, and a complete config is byte-identical after an express update because
nothing is written at all.

Both halves of that are load-bearing. Only keys `buildConfig` writes **unconditionally** may go in
the registry: for the ones it omits when the answer is blank — `reviewer`, `notes`, and above all
`states.abandon` — absent means *answered, with silence*, and asking again every update is exactly
the re-asking express exists to avoid. `tests/config-keys.test.mjs` checks the registry against
`buildConfig`'s real output rather than trusting the distinction to be remembered.

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

It also needs one branch in the installer — an option in the wizard's tracker question and a
`configure<Backend>` beside the two in `bin/install.mjs`, returning the same shape as they do so
every step after it stays provider-agnostic. A backend the wizard cannot configure is a backend
users set up by hand from the README, which is what GitHub Issues was until the wizard learned to
ask which tracker first. `tests/install-config.test.mjs` is where that branch is proved: it feeds
`buildConfig`'s output to the real adapter constructor, so a wizard emitting a config the adapter
rejects fails in CI rather than on a user's first `/dev-task`.

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

**State and its representation are two questions.** A backend that models the ladder on top of
something else keeps two copies of a ticket's state, and they come apart: GitHub closes an issue
itself at merge and the `in review` label stays. `checkRepresentation` / `repairRepresentation` are
that second question — batched read, single write, same shape as `getStates` / `setState`. The
repair rewrites labels and **never** opens or closes anything, so it is not a transition and does
not go through `setState`: recording one would put a second close in the metrics log for work that
closed once. There is deliberately no capability for it. A backend whose state is its own
representation answers "nothing is stale" and no caller needs the branch.

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
7. **`abandon` writes the tracker before it destroys anything, and refuses before it writes.**
   Both halves are the design. A tracker call that fails costs a retry; a branch deleted before the
   reason was recorded costs the reason, which is the only thing abandoning a ticket produces.
   `states.abandon` has no default and must not grow one — everything else in this tool moves a
   ticket forward, so nothing will notice or correct a guess here, and the derived ladder's first
   entry is `In Progress`, the state the ticket is already in.

## What a change to the workflow costs

`tools/profile.mjs` reads Claude Code's own transcripts and reports spend per session and per
ticket, joined to the transition log through the branch name. Repo-local, not shipped —
`package.json#files` does not list `tools/`.

Measure before optimising here, because the intuition is wrong in a specific way. Measured over a
real session:

1. **Cost is context multiplied by turns.** Cache reads and cache writes are ~90% of spend and
   output ~10%. A token added early is paid for by every turn after it; the same token added late
   is paid once.
2. **So the lever is turn count, not prose length.** The whole installed surface — every SKILL.md
   plus every `dev.mjs` command a skill runs at its top — is ~1.4% of a session's context.
   Shortening it saves cents. Collapsing eight model turns into one command saves a whole context
   read per turn removed, which is ~100x more.
3. **Report cost-weighted tokens, never raw counts.** A cached read is worth 0.1 of an input token
   and an output token 5, so raw counts rank the cheapest line item first.

The consequence for design: when a skill tells the model to go and work something out, ask whether
a command could hand it over instead. That is the same question `lib/vcs.mjs` and the metrics
wrapper answer with a choke point — done once, in code, rather than re-derived per session.

## Instrumentation

`lib/metrics.mjs` decides the format; the append is one wrapper around `setState` in
`scripts/cmd/common.mjs`. That placement is the design, for the same reason `lib/vcs.mjs` puts its
refusals in one `git()` call: six commands move tickets, and instrumenting them individually is six
places for the seventh to be forgotten.

1. **The state read back is what gets recorded**, never the rung requested — `sync` passes a ladder
   state rather than a rung, so keying off the argument would miss every reconciled close.
2. **It may never fail a command.** An unwritable or half-written log warns on stderr and the
   transition still happens. An instrument that breaks what it measures is worse than none.
3. **`starts`, not `retries`.** The field is named after what the log can observe. Renaming it to
   something it cannot measure is how a number stops meaning anything.
4. **Local, always.** No network, ever. The file holds no secret and is not meant to be committed.

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
- `tests/`, `tools/`, `.github/`, `.husky/`, `commitlint.config.mjs`, `release.config.mjs` —
  repo-local development only. Never referenced at runtime, never copied into a project. The
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

**The boundary binds the installer, not the user.** `dev.mjs adr` writes decision records into the
project's own `docs/decisions/`, which is outside both roots — and that is correct: the *user* asked
for that file, in that directory, by running the command. What `isOwnedPath` prevents is the
*installer* deciding on its own to write somewhere it does not own, which is a different act
entirely. The line is who chose, not which path. Do not loosen `isOwnedPath` to accommodate a
command; a command that writes user content was never subject to it. The corollary is the reason
the Obsidian setup in `docs/decisions.md` is a recipe rather than an install step: nobody asked the
installer to write `.obsidian/`.

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

- **The ladder is reconciled by CI, not by hand.** `.github/workflows/reconcile.yml` runs
  `dev.mjs sync --apply --deep` on every merged PR, plus weekly. `--deep` is load-bearing: a branch
  named by hand carries no issue ID, so the commit subjects are the only link. So is
  `fetch-depth: 0` on the checkout — this repo delivers `direct`, so most of its work has no PR at
  all and the base-branch commit log is the only evidence there is. At the default depth of 1 that
  log is one commit long and the run reports a clean board. It is **one step**,
  and must stay one: the second step it used to have was repo-local glue spelling `status: in
  review` in shell, and #30 moved that repair into the adapter where the label mapping already
  lives. A workaround added here rather than in `lib/` fixes this repo and no consumer's.

Work with an issue behind it references it as `(#123)`. Work without one keeps the
`<type>(no-ticket):` escape hatch; the type in it is incidental, so any configured type carries it.

Three hooks ship, registered by one list — `SHIPPED_HOOKS` in `bin/lib/payload.mjs`. The merge into
`.claude/settings.json` is what makes a hook apply at all, so a fourth is one entry in that list
rather than a second copy of the merge. Each entry carries its **event** as well as its matcher: the
merge assumed `PreToolUse` until `session-standup.mjs` needed `SessionStart`, which is precisely the
assumption a list exists to prevent. The match stays keyed by command string, per event, so a re-run
adds only what is missing.

Their matchers differ deliberately: the commit guard must see every `Bash` call and is built around
a ~3ms bail for it, while the ADR guard matches `Edit|Write` only, which keeps it off the hot path
at the cost of not seeing an ADR rewritten through `sed -i`. That gap is written down in
`docs/decisions.md` rather than quietly tolerated. `SessionStart` takes no matcher at all — it
guards no tool — and an omitted key is not the same as an empty one.

**The session greeting spends context, not just screen space.** `SessionStart` stdout goes into the
session's context as well as the terminal, so every session of every consumer project pays for the
report in tokens. It is on by default anyway, because a report nobody switches on reports nothing —
but that is a decision with a price, not a free convenience, and `standup`'s own output is the thing
to keep short. The 3s ceiling is the other half: past it the hook prints one line and gives up,
because a greeting that delays a session is worse than no greeting.

**Turning a hook off is one vocabulary.** `hooks.sessionStart`, `hooks.commitTicket` and
`hooks.adrImmutable` in `.dev-workflow.json`, honoured by the hooks themselves — which is what makes
an opt-out survive `--update`, since the installer would otherwise re-add an entry the user deleted.
The two older spellings, `commit.enforce` and `docs.enforce`, are still honoured and must stay so:
they are documented, and an update that switched a guard back on would be exactly the silent
overwrite the manifest exists to prevent. `false` in either place disables. The older key can only
ever disable, never re-enable, so there is no precedence rule to get wrong — the hook tests assert
that directly.

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
