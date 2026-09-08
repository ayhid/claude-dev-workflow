# 0004. Split the task lifecycle into file, plan, split and build, with work units as sub-issues built in parallel

- Status: accepted
- Date: 2026-09-07

## Context

`/dev-task` was one skill that filed an issue, agreed its criteria, planned, created a worktree,
implemented, verified and delivered. Three constraints forced a split. Filing and planning were
coupled to starting: a session that wanted a well-specified ticket for later, or a plan a later
session could pick up, had to run the skill whose next step creates a worktree (#52). The grill and
the filing path existed twice, in `/dev-task` and `/dev-bug`, and had already drifted (#36). And a
ticket whose plan had several independent parts was one branch, one session and one pull request,
against a review lens that refuses past 800 changed lines — nothing could turn a plan into units
that are built at the same time.

Two facts about the runtime bounded the answer. `sync` takes its evidence from pull requests into
the delivery base and commits on it, so a branch merged into a feature branch closes nothing. And
every command that works on a ticket — `start`, `land`, `status`, `standup`, the commit hook —
reads its ticket out of a branch name, so anything that is an ordinary issue with an ordinary
branch needs no change anywhere.

## Options considered

- **Keep one skill and add a checklist of parts to the session** — rejected. The parts live only in
  the conversation, so a second session cannot pick one up, nothing on the tracker shows the split,
  and one branch still carries all of it past the review ceiling.
- **Work units as a local artifact under `_dev-workflow/artifacts/`, one branch, units as
  checkpoints** — rejected. No provider change, but nothing outside the session sees the split,
  `standup` reports one ticket, and the units cannot be built side by side because they share a
  branch.
- **Work units as tracker sub-issues, stacked branches (each unit forked from the previous)** —
  rejected. Stacking needs a branch-to-branch merge the git layer deliberately lacks, and a unit
  merged into a sibling's branch produces no evidence `sync` can see, so the tracker drifts.
- **Work units as tracker sub-issues, every unit forked from the configured base, built in waves**
  — chosen. A unit is an ordinary issue with an ordinary branch, its own commits and its own pull
  request, so every existing command applies unchanged. The dependency between two units is one
  `Depends on:` line in the child's body, read back through the same ID scanner the reconciler
  trusts. A wave is the set of units whose dependencies are done; under `pr` delivery it ends at
  open pull requests and the next wave starts after they merge, because the base is the only place
  a unit's code can be seen from.
- **Parallel Claude sessions, one per unit, hand-coordinated** — rejected as the only mechanism.
  Nothing coordinates the merge order or reconciles once. Kept as a fallback: `build --start`'s
  `dispatch:` lines are usable as a hand-off list.
- **Builders on a cheaper model** — rejected for now. A builder's output is code that ships; its
  mechanical check is partial and its human check is late, so a wrong answer costs a review cycle
  plus a rework across a wave. `model: inherit` — the win the class exists for is parallelism. A
  per-project override is the config-key route ADR 0003 already names, once the profiler shows it
  matters.
- **`/dev-plan` subsuming `/dev-bug`, or `/dev-bug` generalised in place** (#52's open question) —
  neither. `/dev-file` is the one filing path for every configured type; `/dev-bug` keeps its
  trigger vocabulary and the investigation step that a defect needs and a feature does not, and
  hands off. "Something is broken" stays the strongest trigger in the set, and a skill named `bug`
  never files a feature.
- **Removing `/dev-task`** — rejected. CI, the installer's hints, the README and every user name
  it. It stays as a router of about forty lines that decides nothing about the work itself.

## Consequences

Easy: a ticket can be filed, planned, split or built in separate sessions, because each step ends
on the tracker — an ID, a `## Plan` comment, a set of sub-issues, delivered branches — and the next
step reads it back with `fetch`. Independent units are built at once, one `dev-builder` per unit in
its own worktree, and landed a wave at a time with one reconcile. `/dev-file` is #52 in full, and
the grill exists once. A unit is reviewable on its own, under the ceiling.

Expensive: a second wave under `pr` delivery waits for a person to merge the first; `build --start`
fetches the remote base before forking so the wait is at least not wasted. Each builder pays its
own prompt-cache write and prompts for each Bash call unless the session auto-accepts. The commit
hook is the only enforcement for a builder's raw `git`, so it now refuses `--no-verify`; the
`lib/vcs.mjs` choke point binds this tool's calls and nothing else. Every adapter answers two more
questions, `createChild` and `children`, with no capability flag.

Foreclosed: stacked units. A unit never forks from a sibling or a parent branch, and `build` has no
branch-to-branch merge; a plan whose parts form one long chain is built one unit per wave, and
`/dev-split` says so before filing. The parent of a split ticket has no branch: it is closed by
`/dev-done` from its children's evidence, never by `land`.
