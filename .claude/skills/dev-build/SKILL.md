---
name: dev-build
description: Build a planned tracker issue — move it to the in-progress state, create the branch or worktree, implement against the agreed criteria with ticket-referencing commits, verify, and deliver the way the project delivers. When the issue was split into sub-issues, it builds the ready units in parallel, one builder subagent per unit in its own worktree, and lands each wave. Use when a plan is agreed and work should start, when /dev-plan or /dev-split points here, or when the user types /dev-build.
argument-hint: "[ISSUE-ID]"
---

# /dev-build — from an agreed plan to delivered work

`$ARGUMENTS` is an issue ID. If it is a sentence, the issue is not filed: `/dev-file`. If it is
empty, ask which issue, and stop.

The ID shape is the project's, not a guess: `dev.mjs config` reports the provider, and IDs are
`ABC-398` on YouTrack and `#42` on GitHub.

## 0. Load the project's workflow config, and see what is already in flight

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" config
```

**Everything below that says "the configured X" comes from here** — the branch and commit
patterns, delivery mode, the `tdd:` line, per-repo routing and check commands. If it reports
`MISSING`, run `/dev-init` first and stop.

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" status --all
```

It lists every worktree, the ticket each one carries, that ticket's state and whether a PR exists.
Two things it tells you that change what you do next:

- **The work you are being asked for may already be checked out.** Do not create a second worktree
  for the same ticket.
- **A ticket left in progress with a dirty tree is someone's unfinished work** — very possibly this
  session's, before a compaction. Never start over on top of it.

In either case, pick it back up rather than restarting, and read what is already there before
touching anything:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" resume <ISSUE-ID>
```

It puts the worktree back if it went missing, lists the uncommitted files **by name** and the
commits already made, and moves the ticket to the start rung if it is behind. That listing is the
context the previous session had and you do not — read it before deciding anything, and continue
from §4 rather than from §3. Its last line is `cd <path>`: everything after it runs there.

Then reconcile the board before trusting any state you are about to read:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" sync
```

Dry run — it reports drift and changes nothing. A ticket sitting in the review state with a merged
PR simply means nobody has run this since the merge, not that the work is unfinished.

## 1. One unit, or many

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" build $ARGUMENTS
```

- **`children: none`** — the ticket was not split. It is built as one unit, here, in this session:
  §2 to §7.
- **A board of units** — the ticket was split by `/dev-split`. Its units are built by subagents,
  one per ready unit, and landed a wave at a time: §8 to §11. The parent itself gets no branch.

## 2. The criteria and the plan are already agreed — read them back

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" fetch $ARGUMENTS
```

The newest `## Plan` comment is what was approved: its `### Criteria` is the `AC1`, `AC2`, … list
everything below is verified against, and its approach is the one to follow. **Do not re-open
them here.** If there is no `## Plan` comment, the ticket has not been planned: say so and send the
user to `/dev-plan $ARGUMENTS`. Do not plan it in passing.

## 3. Start the work

One command creates the working copy and moves the ticket:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" start $ARGUMENTS
```

It renders the branch name from the configured `branch.pattern` — you do not compose one by hand,
and you do not carry a naming habit over from another project. Add `--print` first if you want to
see the name and the target directory without creating anything.

Two things in its output decide what you do next:

- **`mode:`** — `worktree` means the ticket was checked out in a **separate directory**, printed on
  the last line as `cd <path>`. The repo root is still on the base branch and still holds whatever
  the user had in progress. **Everything from here on runs in that directory** — `git -C <path>`,
  and the repo's checks with their working directory set there. Editing files under the repo root
  instead means editing the wrong checkout, and the commits will not be on the ticket's branch.
  `branch` means the repo root was switched in place, and the paths are the usual ones.
- **`state:`** — the state read back from the tracker. `NOT MOVED` means the working copy exists but
  the transition failed; report it and retry that step alone, rather than starting over.

If it refuses because the tree is dirty, that is `branch` mode protecting uncommitted work. Commit
or stash it, or switch the project to worktree mode, which never has this problem.

## 4. Implement

Commit subjects follow the configured commit pattern, which the hook and commitlint alike enforce.
The default is:

```
type(scope): description ($ARGUMENTS)
```

Where the ID sits matters: with `position: suffix`, a bare `$ARGUMENTS: description` prefix is
rejected. The PreToolUse hook installed in `.claude/settings.json` blocks a non-conforming inline
`-m` before it reaches git, and refuses `--no-verify` outright.

Rules:

- **Never bypass hooks** — no `--no-verify`, no `HUSKY=0`. If a hook blocks you, fix the cause.
- Prefix commands with the repo's configured `env` when it has one; a missing pin usually shows
  up as a version manager failing to resolve a runtime.
- Use the repo's configured package manager, and only that one.
- Commit in small, reviewable batches rather than one large commit at the end.

**How the code gets written is the `tdd:` line in §0's output**, not a per-session preference:

- **`tdd: on`** (the default, and what a project that has never heard of the key reads as) — drive
  each criterion through `/dev-tdd`: one criterion at a time, a test confirmed to fail for the
  intended reason before any production code, then a refactor while green. It takes the criteria
  §2 read back and does not re-open them.
- **`tdd: off`** — implement directly. Nothing else changes: §5 still walks every criterion and
  still wants evidence for each, so a criterion with no test needs the command output that shows
  it works.

## 5. Before delivering

Do both, in order, and do them before §6 rather than after — `direct` delivery lands on the base
branch immediately, so an unverified criterion is not a review comment, it is a bad commit on `main`.

1. **Walk the acceptance criteria one at a time.** For each, state met or not met and cite the
   evidence — the file and line, the test, or the command output. Do not batch-assert "all done".
2. **Run the repo's configured checks**, with the working directory set to the checkout you have
   been editing (the worktree, in worktree mode). Report failures honestly rather than summarising
   them away. If none are configured, find them in the project's own scripts and say which you ran.

Never claim a criterion is met when it is not.

## 6. Deliver

Ask the user before this step, every time. How finished work reaches the base branch is
`delivery.mode` in the config, **not a decision you make per session**. A project set to `direct`
does not want a pull request, and opening one anyway is not a helpful extra step — it is ignoring
the configuration.

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" land          # dry run: what would happen
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" land --apply --criteria <first-pass|reworked>
```

`--criteria` records whether §5's walk passed on the first attempt (`first-pass`) or sent you back
to the code (`reworked`). Leave it off if you genuinely cannot tell — the field then records that
nobody said, which is better than a guess.

It infers the issue from the branch, then follows the configured mode: `pr` pushes the branch, opens
the pull request, requests the configured reviewer and reconciles the ticket to the review state;
`direct` rebases onto the base, fast-forwards it, pushes, removes the worktree and closes the ticket.

Show the dry run and get confirmation before `--apply`. Two failures are expected and neither is a
reason to improvise:

- **a rebase conflict** — it aborts and leaves the branch exactly as it was. Resolve the conflict on
  the branch, then run it again. Never force a resolution to get past it.
- **`could not confirm a pull request`** — `gh pr create` reports failure for PRs it created, so the
  command checks the PR itself. If it says the reviewer is missing, add them by hand.

Post a summary comment on the ticket as part of landing it, so the tracker says what changed:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" update $ARGUMENTS comment "<summary>"
```

Never run this step unprompted. `/dev-done` does the same close-out and re-verifies from scratch —
prefer it when the work spanned more than one session.

## 7. If the work is being dropped instead

Only when the **user** says to stop — a wrong approach, a ticket overtaken by another. Never on your
own judgement, and never because something turned out to be hard.

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" abandon $ARGUMENTS "<why, in one line>"
```

It records the reason on the ticket, moves it to the configured `states.abandon`, then removes the
worktree and deletes the branch. The reason is what a reader finds months later, so write the real
one: "superseded by #31" or "the API cannot support this", not "abandoned".

It refuses while the branch still holds uncommitted changes or commits the base branch has not seen,
and lists them. **Show that list to the user and ask before passing `--force`** — that flag is what
discards the work, and nothing recovers it afterwards. If they would rather keep the work, stop:
leave the branch alone and say so.

---

## 8. Many units — start the ready ones

Only when §1 printed a board. Read it: each unit is `done`, `review`, `in progress`, `ready`,
`blocked` (waits on units not yet done) or `unknown` (an unreadable or off-ladder state, never
started automatically — the line says which key to fix). The `next:` line names the step.

Three things to say before starting a wave, because each one costs the user something:

- Every builder's Bash call prompts for permission unless the session auto-accepts; a wave of three
  builders is three streams of prompts.
- A project whose checks bind a port, or a dev server, cannot run them in parallel; the builders
  run the checks anyway, and a collision reads as a failure in the report. Say so if it applies.
- Under `pr` delivery the wave ends at open pull requests; the next wave starts after they merge.
  Under `direct` it chains.

Then:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" build $ARGUMENTS --start
```

It moves the parent to the start rung if it is behind, fetches the base so the units fork from
what has actually landed, mounts one worktree per ready unit — serially, sharing one provider — and
ends with one line per unit to build:

```
dispatch: #45	/abs/path/.worktrees/feat-45-slug
```

A refusal in `branch` mode with several units ready names the key to change; do not work around
it by starting them one at a time in the root.

## 9. Dispatch one builder per unit, at most three at a time

Each `dispatch:` line becomes one fresh `dev-builder` subagent — `subagent_type: dev-builder`,
never more than one unit to an agent. **The dispatch message is the worktree path and the unit's
ID, and nothing else**: no plan, no criteria, no summary of the parent. The builder reads the
project's config and the unit's ticket itself, follows `/dev-tdd`'s loop when the project has it
on, commits with the unit's ID, runs the repo's checks, and returns one JSON report. Dispatch a
wave's builders together so they run at once; past three, dispatch the next as one returns.

`dev-builder` ships with the payload (`.claude/agents/dev-builder.md`) and carries the rules that
keep parallel builders safe as its own system prompt — everything under its path only; no `push`,
`stash`, `fetch`, `rebase`, `worktree` or `--no-verify`; no `dev.mjs` command that writes, which is
what keeps the metrics log at one writer. Its model is `inherit`: the win here is parallelism, not
a cheaper model, and code that ships earns the model the session runs on.

**No builder runs in this session, and this session reads no builder's diff.** A diff pasted here is
paid for again on every later turn; that is the whole reason the unit went to a subagent.

If no subagent tool is available, build the ready units one at a time here, following §2 to §6 in
each worktree in turn, and say so.

## 10. Collect, verify, land the wave

Take the reports **one at a time, serially**. For each:

1. **Read the report.** `status: done` with `checks: pass` is a claim, not evidence; `blocked` or
   `failed` names the unit — leave its worktree exactly as it is and let the user decide.
2. **Run the repo's checks yourself**, in that unit's worktree, and cite the result.
3. **Audit the unit against its criteria**, without reading its diff here. Build the review payload
   in the worktree and dispatch the audit lens on it — the same lens `/dev-review` runs, which
   checks the change against the ticket criterion by criterion and quotes its evidence:

   ```bash
   cd <worktree> && node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" review
   ```

   then one `dev-review-audit` subagent with the payload directory's path as its whole message. An
   unmet criterion in its findings holds the unit back; the blind and edge lenses stay with the
   pull request's ordinary `/dev-review`.

Then the wave lands together:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" build $ARGUMENTS --land           # dry run
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" build $ARGUMENTS --land --apply
```

The dry run lists every unit that is committed and clean, skips a dirty one by name, and shows
each unit's own `land` plan. **Show it and get one confirmation for the wave**, then `--apply`: it
lands the units one after another and reconciles the tracker once. A unit that refuses to land
stops the loop where it is — the units before it have landed, the one that failed says why, the
rest are untouched. A rebase conflict under `direct` delivery is resolved on that branch by a
person, never forced.

Under `pr` delivery, **stop here** and say so: the next wave unblocks when these pull requests
merge — `dev.mjs sync`, then `/dev-build $ARGUMENTS` again, and §8 picks up the newly ready units.
Under `direct` delivery, go back to §8 for the next wave.

## 11. When the board shows every unit done

The parent has no branch of its own; its evidence is its children. Hand it to `/dev-done
$ARGUMENTS`, which walks the parent's criteria across the landed units and closes it. Do not close
it from here.
