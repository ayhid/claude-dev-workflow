---
name: dev-standup
description: Report everything in flight across the project's repos — what merged recently, what is checked out, what has stopped moving, what is still open on the tracker, and the one thing waiting on you. Use when the user asks for a standup, what they were working on, what is in progress, what landed yesterday, or what to pick up next.
argument-hint: "[optional --since 3d]"
---

# /dev-standup — where everything stands

One command answers all of it. Run it first, before saying anything:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" standup $ARGUMENTS
```

It scans every configured repo and reads the tracker, so nothing here needs to be assembled by hand
from `git`, `gh` or the issue list. Five sections come back, in this order:

- **merged since** — what landed inside the window, with each ticket's current state. A line
  marked *merged, but the ticket has not been reconciled* is drift, not finished work.
- **in flight** — one row per ticket branch: state, PR, whether the tree is dirty or ahead of the
  base, and how long since its last commit.
- **stale** — anything with no commit for the threshold (7 days by default).
- **open in the tracker** — every open issue nothing above already accounts for: the work that
  exists but has not been started here. Capped, with a count of the rest.
- **next** — the single highest-priority thing waiting on *you*, or a line saying nothing is. It
  ranks work **in flight only** and never picks from the open list; when nothing in flight is yours
  it points at that section instead, because starting something is the user's decision.

## Reading it out

Report what it says. Do not re-derive any of it, and do not soften it: "three tickets have not moved
in two weeks" is the finding, and burying it is how a standup becomes decoration.

Two lines are worth expanding on when they appear, because both are cheap to fix and neither fixes
itself:

- **a merged PR whose ticket never moved** → offer `dev.mjs sync --apply`.
- **a stale branch** → say how long, and offer the two ways out: `dev.mjs resume <ID>` to pick it
  back up, or `dev.mjs abandon <ID> "<why>"` to drop it. Never guess which the user wants.

If `next` says nothing is waiting on you, say exactly that. Do not go looking for something to
suggest — a report that invents work is one nobody trusts twice.

## What it cannot see, and must not pretend to

Coverage is local checkouts, pull requests **and the tracker's open issues**. What it does not show
is anything the tracker calls closed. If the user asks about a ticket that is not on the board,
fetch it rather than concluding it does not exist:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" fetch <ISSUE-ID>
```

**`could not read the tracker` is not an empty board.** When that line appears, the open section and
the `next` line know nothing about what is unstarted — say so, and do not report the board as clear.

`--since` defaults to one day, which is the wrong window on a Monday and after time off — pass
`--since 3d` or `--since 7d` and say which window you used. `--stale` moves the staleness threshold
the same way.

Without the GitHub CLI the PR columns read `-` and the merged section is empty. The report still
runs, and it says so at the bottom; repeat that caveat rather than reporting "nothing merged" as
though it were a fact.

## This skill never writes

It reports. It does not move a ticket, land a branch, open a PR or delete anything, and it does not
run `sync --apply` on its own initiative — a command people run first thing in the morning has to be
safe to run without thinking about what it might do to the board.

Every fix it suggests is a command for the user to approve. Run one only when they ask for it, and
then follow that command's own skill: `/dev-task` to pick work up, `/dev-done` to close it out.
