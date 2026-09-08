---
name: dev-build
description: Build a planned tracker issue — move it to the in-progress state, create the worktree, dispatch a builder subagent in the background, verify its report with evidence, and deliver the way the project delivers. The session orchestrates and never builds. A split ticket has its ready units built in parallel, one builder per unit, landed a wave at a time; `auto` chains the waves under direct delivery. Use when a plan is agreed and work should start, when /dev-plan or /dev-split points here, or when the user types /dev-build.
argument-hint: "[ISSUE-ID] [auto]"
---

# /dev-build — from an agreed plan to delivered work

`$ARGUMENTS` is an issue ID, optionally followed by `auto` (§8). If it is a sentence, the issue is
not filed: `/dev-file`. If it is empty, ask which issue, and stop.

The ID shape is the project's, not a guess: `dev.mjs config` reports the provider, and IDs are
`ABC-398` on YouTrack and `#42` on GitHub.

**The session is the orchestrator, always.** It starts the ticket, dispatches builders, collects
their reports, verifies and delivers. It never builds, and it never hands the run to another
agent. A builder builds one unit in one worktree and reports; it dispatches nothing and writes
nothing to the tracker. That keeps the diff and every test run out of this session's context,
where it would be paid for again on every later turn, and keeps the session free while the build
runs.

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

Every worktree, the ticket each carries, its state and whether a PR exists. Two things change what
you do next: **the ticket may already be checked out** — never create a second worktree for it —
and **a ticket in progress with a dirty tree is unfinished work**, very possibly this session's
before a compaction. Never start over on top of it. In either case pick it back up:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" resume <ISSUE-ID>
```

It puts the worktree back if it went missing, lists the uncommitted files **by name** and the
commits already made, and moves the ticket to the start rung if it is behind. Read that listing
before deciding anything, then continue from §3 with the worktree it printed.

Then reconcile the board before trusting any state you are about to read:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" sync
```

Dry run — it reports drift and changes nothing.

## 1. One unit, or many

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" build $ARGUMENTS
```

- **`children: none`** — the ticket was not split. It is one unit: `start` it (§2), dispatch one
  `dev-builder` for it (§3), collect and verify (§4), deliver (§5).
- **A board of units** — the ticket was split by `/dev-split`. Its ready units are started
  together (§6), dispatched the same way (§3), verified the same way (§4) and landed a wave at a
  time (§7). The parent itself gets no branch.

## 2. The plan is agreed — read it back, then start

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" fetch $ARGUMENTS
```

The newest `## Plan` comment is what was approved: its `### Criteria` is the `AC1`, `AC2`, … list
everything is verified against. **Do not re-open them here.** If there is no `## Plan` comment,
the ticket has not been planned: say so and send the user to `/dev-plan $ARGUMENTS`.

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" start $ARGUMENTS
```

It renders the branch from the configured `branch.pattern`, forks from the freshest base it can
see and says which on its `forked:` line, and moves the ticket. Two lines decide what happens
next: **`mode:`** — `worktree` means a separate directory, printed last as `cd <path>`, which is
the builder's whole world; `branch` means the repo root was switched in place, and the builder
works there. **`state:`** — `NOT MOVED` means the checkout exists and the transition failed;
retry that step alone. A refusal because the tree is dirty is `branch` mode protecting
uncommitted work: commit or stash it, or switch the project to worktree mode.

## 3. Dispatch one builder per unit, in the background

Each unit becomes one fresh `dev-builder` subagent — `subagent_type: dev-builder`, run in the
background, never more than one unit to an agent. **The dispatch message is the worktree path and
the unit's ID, and nothing else**: no plan, no criteria, no summary. The builder reads the
project's config and the unit's ticket itself, follows `/dev-tdd`'s loop when the project has it
on, stops the line on a red suite, commits with the unit's ID, runs the checks once, and returns
one JSON report. Its rules ship as its own system prompt (`.claude/agents/dev-builder.md`): its
worktree only, no `push`, `fetch`, `stash`, `rebase` or hook bypass, no `dev.mjs` write, and
`blocked` rather than a guess on anything irreversible. Its model is `inherit`: code that ships
earns the model the session runs on.

On a wave, dispatch at most three at once and the next as one returns. Say, before dispatching,
what each builder costs the user: every builder's Bash call prompts unless the session
auto-accepts, and checks that bind a port cannot run in parallel — a collision reads as a failure.

While a builder runs, the session does nothing on that unit. Tell the user it is running, and
answer what else they ask. **No builder runs in this session, and this session reads no
builder's diff.** If no subagent tool is available, say so and stop: this skill has no in-session
build path.

## 4. Collect and verify — one report at a time

For each report, in the order they arrive:

1. **Read it.** `status: done` with `checks: pass` is a claim, not evidence. `blocked` or
   `failed` names the unit: leave its worktree exactly as it is and put its `notes` to the user
   — an irreversible step is theirs to take, a root cause not found is theirs to look at.
2. **Run the configured checks yourself**, in that unit's worktree, and cite the result.
3. **Audit the unit against its criteria**, without reading its diff here:

   ```bash
   cd <worktree> && node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" review
   ```

   then one `dev-review-audit` subagent with the payload directory's path as its whole message.
   An unmet criterion in its findings holds the unit back; the blind and edge lenses stay with the
   pull request's ordinary `/dev-review`.
4. **Carry `noticed` forward** into the closing comment (§9). Nothing in it is fixed now.

Never claim a criterion met when it is not. `direct` delivery lands on the base immediately, so
an unverified criterion is a bad commit on `main`, not a review comment.

## 5. Deliver one unit

Ask the user before this step, every time (`auto`, §8, is the one exception, and only between
waves). How work reaches the base branch is `delivery.mode`, **not a decision you make**.

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" land          # dry run
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" land --apply --criteria <first-pass|reworked>
```

`--criteria` records whether §4 passed first time or sent a builder back. `pr` pushes, opens the
pull request and reconciles the ticket to the review state; `direct` rebases, fast-forwards,
pushes, removes the worktree and closes the ticket. Show the dry run and get confirmation before
`--apply`. A rebase conflict aborts and leaves the branch as it was: resolve it there, run it
again, never force it. `could not confirm a pull request`: the command checks the PR itself; add
a missing reviewer by hand. Then post the closing comment (§9). `/dev-done` does the same
close-out and re-verifies from scratch — prefer it when the work spanned more than one session.

---

## 6. Many units — start the ready ones

Only when §1 printed a board. Each unit is `done`, `review`, `in progress`, `ready`, `blocked` or
`unknown` (never started automatically — the line says which key to fix). The `next:` line names
the step. Under `pr` delivery the wave ends at open pull requests; under `direct` it chains.

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" build $ARGUMENTS --start
```

It moves the parent to the start rung if it is behind, fetches the base so the units fork from
what has actually landed, mounts one worktree per ready unit, and ends with one line per unit:

```
dispatch: #45	/abs/path/.worktrees/feat-45-slug
```

Each line is one §3 dispatch. A refusal in `branch` mode with several units ready names the key
to change; do not work around it by starting them one at a time in the root.

## 7. Land the wave

After every unit of the wave passed §4:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" build $ARGUMENTS --land           # dry run
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" build $ARGUMENTS --land --apply
```

The dry run lists every unit that is committed and clean, skips a dirty one by name, and shows
each unit's own `land` plan. **Show it and get one confirmation for the wave**, then `--apply`: it
lands the units one after another and reconciles the tracker once. A unit that refuses to land
stops the loop where it is; a rebase conflict under `direct` is resolved by a person, never
forced. Under `pr` delivery, **stop here**: the next wave unblocks when these pull requests merge
— `dev.mjs sync`, then `/dev-build $ARGUMENTS` again. Under `direct`, back to §6 for the next
wave, or §8 chains it.

## 8. `auto` — every wave, one approval

`/dev-build <ID> auto` removes the human between waves, not the verification: every unit still
gets §3, §4 and the dry run. It is **refused under `pr`** — a wave ends at open pull requests,
and nothing here merges one — so it requires `delivery.mode: direct`; say so and stop otherwise.

One checkpoint, before the first dispatch: show the board, the waves and their cost, and wait for
a plain `approve`, `go` or `yes`. **Hedged approval is not approval** — "looks fine", "I guess",
"sure, probably" — ask again. After that, §6 → §3 → §4 → §7 `--land --apply` repeat without a
prompt until the board shows every unit done, or until one of these stops the run: a `blocked`
or `failed` report, an unmet criterion in §4, a unit that refuses to land. Then it stops where it
is, says which unit and why, and the user re-invokes `/dev-build <ID> auto` to resume from the
next ready unit.

## 9. Closing comment

Post it on the ticket as part of landing, so the tracker says what changed — one per unit, and
one on the parent when its last unit lands. Five items, in this order, each one line or a list:
**commits** (subjects); **tests** added, by name; **criteria**, each with its evidence;
**`noticed`** — what the builder saw outside the unit, for someone to file or drop;
**blocked or skipped** — anything left for a person, with the reason.

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" update <ID> comment @<scratch>/closing.md
```

## 10. When the board shows every unit done

The parent has no branch of its own; its evidence is its children. Hand it to `/dev-done
$ARGUMENTS`, which walks the parent's criteria across the landed units and closes it.

## 11. If the work is being dropped instead

Only when the **user** says to stop. Never on your own judgement, and never because something
turned out to be hard.

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" abandon $ARGUMENTS "<why, in one line>"
```

It records the reason on the ticket, moves it to `states.abandon`, then removes the worktree and
deletes the branch. Write the real reason: "superseded by #31", not "abandoned". It refuses while
the branch holds uncommitted changes or commits the base has not seen, and lists them. **Show that
list and ask before `--force`** — that flag discards the work, and nothing recovers it.
