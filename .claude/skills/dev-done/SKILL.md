---
name: dev-done
description: Finish work on the current branch's tracker issue — verify acceptance criteria, run the project's checks, and on confirmation move the ticket to the configured done state with a summary comment. Use when the user says they are done or types /dev-done.
argument-hint: "[optional ISSUE-ID]"
---

# /dev-done — close out the current branch's issue

## 0. Load the project's workflow config

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" config
```

Gives the state ladder (specifically which state means *finished* on this project), the per-repo
check commands, the commit pattern, and the ticket language. If it reports `MISSING`, run
`/dev-init` first and stop.

Then reconcile the board before trusting any state you are about to read:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" sync
```

Dry run — it reports drift and changes nothing. A ticket sitting in the review state with a merged
PR simply means nobody has run this since the merge, not that the work is unfinished.

## 1. Get the issue ID, and find the checkout it belongs to

If `$ARGUMENTS` carries one, use it. Otherwise `dev.mjs land` infers it from the branch you are on,
and its dry run prints it back:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" land
```

Do not parse the branch by hand: the ID's shape is the project's (`ABC-398` on YouTrack, `#42` on
GitHub, and a GitHub branch carries the bare number because a ref cannot hold a `#`). If it reports
that it could not read an ID out of the branch, **ask the user. Do not guess**, and do not fall back
to the most recent ticket you happen to have seen.

**Check which checkout you are in first.** In worktree mode the work is in a directory under
`.worktrees/`, not the repo root, and the root is still sitting on the base branch:

```bash
git rev-parse --show-toplevel     # the checkout you are actually in
git branch --show-current
```

Everything below — the diff, the checks, the commit log — must run against that directory. Running
them at the repo root would report a clean tree and no commits, and read as "nothing was done".

## 2. Re-read the ticket

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" fetch <ISSUE-ID>
```

Re-read rather than trusting earlier context: comments may have been added while you worked,
and the state may have moved underneath you.

## 3. Verify each acceptance criterion

Walk the checklist one criterion at a time. For each, state **met** or **not met** and cite
concrete evidence — a file and line, a passing test, or command output.

**When a criterion is about deployed behaviour, a merged PR is not evidence.** Tickets often close
on "fixed *and* verified in the environment". Merging proves the code landed, not that the running
system changed. Verify the artifact that is actually serving:

- fetch the deployed asset and confirm it carries the fix (a distinguishing symbol from the diff
  survives minification more often than you would expect);
- exercise the real thing — load the page, call the endpoint — and compare against the numbers in
  the ticket's reproduction steps.

Quote the before-and-after. "The cycle that repeated indefinitely now fires once" is evidence;
"deployed" is not.

If any criterion is unmet, say so plainly and stop. Do not close a ticket whose criteria are
not satisfied; report what is missing and let the user decide.

## 4. Run the project's checks

Run the checks configured for the repo the work landed in, with its configured `env` prefix.
If none are configured, find the project's own test and lint entry points and say which you ran
— and watch for watch-mode targets that never exit.

Report failures with their output. A failing suite blocks closing the ticket — **unless the
failures are pre-existing**, and you have shown that rather than assumed it.

To tell the two apart, compare what fails against what the branch changed:

```bash
git -C <repo> show --name-only --format= <commit>   # what this work touched
```

A failure in a file or module the branch never touched is pre-existing. Say so explicitly, name
the module, and cite the commit's file list as the evidence. Then run the suite that *does* cover
the change on its own and report that result separately — "39 suites green in the plugin under
test, 3 unrelated failures elsewhere" is an honest close-out; "tests pass" is not.

Never wave a failure away without doing this comparison. If the failing files overlap the change
at all, treat it as caused by the work and stop.

## 5. Confirm the diff is committed

```bash
git -C <repo> status --short
git -C <repo> log --oneline <base>..HEAD
```

`<repo>` here is the checkout identified in §1 — the worktree, not the repo root, when the project
uses worktree mode.

Every commit should match the configured commit pattern and carry the issue ID. Uncommitted work
means the ticket is not done — surface it rather than closing over it.

## 5.5. Anything worth keeping?

Before landing, ask yourself what this ticket taught that **the code does not already say** and that
the next session would otherwise rediscover the hard way: a trap in an API, why an approach was
rejected, a convention nothing enforces. If there is something, offer it to the user in one line and
write it on approval:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" note "<the durable fact>"
```

It lands in the project's notes file, tagged with the date and this ticket, and is shown to every
later `/dev-task`, `/dev-bug` and `/dev-done`.

Most tickets teach nothing durable, and **that is the normal case** — say nothing rather than
manufacturing a note. Three things do not belong here:

- what changed, or how it was verified — that is the ticket summary in §6;
- anything the diff already says, or that a reader would learn from the code;
- working notes about this ticket. Those go on the ticket:
  `dev.mjs update <ISSUE-ID> comment "…"`.

A notes file that fills with restated commit messages is worse than an empty one, because the next
session has to read all of it to find the two lines that mattered.

## 6. Ask, then land

Draft a summary comment **in the configured ticket language**: what changed, which files, how it
was verified. Show it to the user, along with the `dev.mjs land` dry run from §1 so they can see
exactly what landing will do. Ask whether to go ahead.

**Only on explicit confirmation**, post the summary and land the work:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" update <ISSUE-ID> comment "<summary>"
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" land --apply
```

`land` does whatever `delivery.mode` says — open the pull request, or rebase onto the base branch,
fast-forward it, push, tear the worktree down and close the ticket. **That is a configuration
decision, not yours to override**: do not open a PR on a project set to `direct`, and do not push
straight to the base on a project set to `pr`.

Two cases where the ticket correctly does not move, and neither is a reason to force it:

- **`pr` mode, PR not merged yet.** The reconciler has no merge to act on, so the ticket stays in
  the review state. That is the right answer; say so.
- **a rebase conflict in `direct` mode.** It aborts and leaves the branch untouched. Resolve it on
  the branch and run again.

If the project genuinely has no delivery path for this work — a spike, or something already landed
by hand — apply the transition alone:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" update <ISSUE-ID> state done "<summary>"
```

Confirm the read-back line reports the expected state. If it reports anything else, the write did
not apply — report that rather than assuming success.

In worktree mode a successful `direct` land deletes the directory you are standing in. The command
prints a `cd <repo root>` line for that reason; follow it before running anything else.
