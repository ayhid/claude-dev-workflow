---
name: dev-split
description: Turn a planned tracker issue into work units filed as its sub-issues — read the plan back off the ticket, propose units that can be built apart with their own acceptance criteria and dependencies, and file them with dev.mjs split on approval. Starts nothing, edits nothing, creates no branch. Use when a plan names independent parts, when /dev-plan points here, or when the user types /dev-split.
argument-hint: "[PARENT-ISSUE-ID]"
---

# /dev-split — a plan's independent parts become sub-issues

`$ARGUMENTS` is the ID of a ticket `/dev-plan` has planned. If it is empty, ask which, and stop.

**Splitting is not starting.** This skill ends at a table of child issue IDs. It never edits a
file, never creates a branch or worktree, and never moves a ticket. `/dev-build <PARENT>` is the
step that starts them, and it is the user's to invoke.

Why units are tracker issues rather than a checklist in this session: each one gets its own branch,
its own commits carrying its own ID, its own pull request and its own row on `/dev-standup` — every
command that works on a ticket works on a unit unchanged. The only thing that ties them together is
the parent link the tracker holds and one `Depends on:` line in each unit's body.

## 0. Load the project's workflow config

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" config
```

Gives the ticket language, the configured `issueTypes`, and the repo layout. If it reports
`MISSING`, run `/dev-init` first and stop.

## 1. Read the plan back

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" fetch $ARGUMENTS
```

The input to this skill is the **newest `## Plan` comment** on the ticket — its criteria, its
approach, and its `### Independent parts`. Not a plan from this session's memory: the comment is
what was approved.

- **No `## Plan` comment.** The ticket has not been planned. Say so and send the user to
  `/dev-plan $ARGUMENTS`; do not plan it here.
- **A `## Sub-issues` section already lists children.** It was split before. Show them and ask
  whether the split is complete (then stop, pointing at `/dev-build`) or needs more units (then
  continue: `split` skips a unit whose title already exists, so only the new ones are filed).

## 2. Propose the units and wait

One unit per independent part of the plan, refined by these rules:

- **Every parent criterion lands in exactly one unit.** A criterion nobody owns is work nobody
  does; one two units own is work done twice.
- **A unit is independent of another when their files do not overlap and neither's criteria need
  the other's code.** Anything else is a dependency, and it is named — a unit that needs another's
  code to exist depends on it.
- **A unit stays under the review ceiling.** `/dev-review` refuses past 800 changed lines; a unit
  that would blow past it is two units.
- **A unit names its repo** when the project configures more than one. A branch lives in one repo.
- **A unit is one type**, from the configured `issueTypes` — it decides the unit's branch type.

Show the table, then the waves `split --print` will compute — units with no dependencies first,
then the ones that wait on them — and the ceiling they imply: under `pr` delivery a wave ends at
open pull requests, and the next wave starts after they merge. If everything lands in wave 1, the
split is worth it; if it is one long chain, say so — a chain built one unit at a time is the plan
`/dev-build` runs anyway, and the split buys review size, not parallelism.

**Wait for explicit approval.** Two units and a chain is a legitimate answer; so is "do not split".

## 3. Write the units file

Write it to the scratch directory, one entry per unit, dependencies as **0-based indexes into the
same file** — the IDs do not exist yet:

```json
[
  {
    "summary": "<component>: <what this unit delivers>",
    "description": "## Problem\n…\n\n## Acceptance criteria\n\n- [ ] AC1: …",
    "type": "<one of issueTypes>",
    "dependsOn": [],
    "repo": "<configured repos[].path — only in a multi-repo project>"
  }
]
```

Each `description` is written in the configured ticket language and **must carry a
`## Acceptance criteria` section** — the unit's own subset of the parent's criteria, verbatim,
with their original IDs so `/dev-done` on the parent can trace each one. `split` refuses a unit
without one, by unit number and field.

Then the dry run, and check it prints the waves you showed:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" split $ARGUMENTS @<scratch>/units.json --print
```

## 4. File them

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" split $ARGUMENTS @<scratch>/units.json
```

It files the units **in wave order**, so each `Depends on:` line names IDs that exist, links every
one under the parent, and reads the link back. A warning on stderr means a unit exists but its
link did not take — say which, with the ID; do not file it again. A failure part way through
prints what was filed; **rerun the same command**, and the filed units are skipped by title.

## 5. Stop

Show the table the command printed — IDs, waves, dependencies — and one line:

> Next: `/dev-build $ARGUMENTS` — wave 1 can start now.

Do not run it yourself.
