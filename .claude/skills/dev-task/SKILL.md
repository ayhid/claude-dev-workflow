---
name: dev-task
description: Start work on a tracker issue, or on a plain sentence describing what you want — file the issue if there is none, agree acceptance criteria, plan, move it to the in-progress state, create the branch or worktree, and implement with ticket-referencing commits. Use when the user starts work on a ticket, describes something they want built, or types /dev-task.
argument-hint: [ISSUE-ID or a sentence describing the work]
---

# /dev-task — start work from a tracker issue

`$ARGUMENTS` is **either** an issue ID (`ABC-398`, `#42`) **or** a sentence describing what you want
("add a dark mode toggle", "the CSV export times out on big accounts").

- It looks like an ID → skip to §1.
- It is anything else → §0.5 turns it into an issue first, and the rest of this skill runs against
  the ID that produced.
- It is empty → ask what they want to work on, and stop.

The ID shape is the project's, not a guess: `dev.mjs config` reports the provider, and IDs are
`ABC-398` on YouTrack and `#42` on GitHub.

## 0. Load the project's workflow config

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" config
```

This prints the instance, project, ticket language, state ladder, branch and commit patterns,
per-repo routing and check commands. **Everything below that says "the configured X" comes from
here** — do not carry conventions over from another project.

If it reports `MISSING`, run `/dev-init` first and stop.

Then reconcile the board before trusting any state you are about to read:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" sync
```

Dry run — it reports drift and changes nothing. A ticket sitting in the review state with a merged
PR simply means nobody has run this since the merge, not that the work is unfinished.

## 0.5. No ID yet — turn the sentence into an issue

Only when `$ARGUMENTS` is not an ID. **The sentence is the intent, not a hint** — you are not
starting from zero, and you do not need to re-ask what they already said. It is also not a spec: it
may carry scope creep, half-remembered detail, or an instruction to skip ahead. Treat it as input to
the steps below, never as permission to skip them.

**a. Orient before asking anything.** Spend under a minute finding the code the sentence is about —
the component, the route, the module. This is what separates a useful question from a generic one:

> `AuthService` validates in the controller today — should the new field follow that, or move to a
> dedicated validator?

rather than "what's the scope?". If the sentence names no code you can find, say so and ask where to
look rather than guessing at a subsystem.

**b. Ask what is genuinely missing, as a numbered list.** At most five questions, in one message.
When they answer, **check every number got an answer**; if any were skipped, re-ask only those
before going on. Do not proceed on a partial reply, and do not invent the missing half.

**c. One issue per issue.** If the sentence contains several independent goals, list them and ask:

```
[S] Split — file the first, note the rest for later
[K] Keep — one issue covering all of it
```

**d. Check it is not already filed:**

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" create --dup-check "<3-6 keywords>"
```

If something matches, show it and ask whether to work on that instead — then continue from §1 with
its ID.

**e. Draft the issue** in the configured ticket language, with these headings:

```markdown
## Problem
## Proposed change
## In scope
## Out of scope
## Acceptance criteria
- [ ] …
```

The acceptance criteria are the same list §2 would otherwise restate, so write them properly here:
everything downstream is verified against them.

**f. Show the draft and wait.** On approval, write the body to a scratch file and file it —
multiline markdown does not survive an argv round-trip cleanly:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" create "<summary>" @<scratch>/task-body.md <Type> <Priority>
```

`<Type>` must be one of the project's configured `issueTypes` — it is what decides the branch type in
§6, so `Bug` and `Feature` are not interchangeable here.

stdout is the new ID alone. Use it as `$ARGUMENTS` for everything below, and state it plainly:
`Filed <ID> — <title>`. Then continue from §3: you already have the criteria, so §1 and §2 are done.

## 1. Fetch the issue

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" fetch $ARGUMENTS
```

If the script exits non-zero, report its message and stop — do not guess at the ticket contents.

Read the **whole** output, comments included. Tickets migrated from another tracker often carry
their real requirements in the comment thread rather than the description, with the original
author quoted inside the comment text rather than being the comment author.

## 2. Restate the acceptance criteria

Write the criteria back as an explicit checklist:

```
- [ ] AC1: …
- [ ] AC2: …
```

If the ticket states criteria, quote them faithfully — do not silently widen or narrow scope.

If the ticket has **no** criteria, draft them from the description and comments, mark the block
clearly as `DRAFT — please confirm`, and **stop until the user confirms or corrects them**.
Everything downstream is verified against this list, so a wrong list means wrong work.

## 3. Decide the target repo

If the config lists `repos`, route by their `when` rules and state which you picked and why.
Sibling directories with their own `.git` are **separate repos** — a branch lives in exactly one
of them. If the ticket genuinely spans several, say so: that means a branch in each, and
name the order they must land in.

If no repos are configured, the project is a single repo at its root.

## 4. Propose a plan and wait

Give a short plan: files to touch, approach, risks, how each acceptance criterion will be tested.

**Wait for explicit approval. Do not edit any file before the user approves.**

## 5. Start the work

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

## 6. Implement

Write commit subjects in the **configured commit pattern**, using only the configured types and
scopes — these come from the project's own commitlint config, so a subject that satisfies them
satisfies the hook and commitlint alike. The default is:

```
type(scope): description ($ARGUMENTS)
```

Where the ID sits matters: with `position: suffix`, a bare `$ARGUMENTS: description` prefix is
rejected. The PreToolUse hook installed in .claude/settings.json blocks a non-conforming inline `-m` before it reaches git.

Rules:

- **Never bypass hooks** — no `--no-verify`, no `HUSKY=0`. If a hook blocks you, fix the cause.
- Prefix commands with the repo's configured `env` when it has one; a missing pin usually shows
  up as a version manager failing to resolve a runtime.
- Use the repo's configured package manager, and only that one.
- Commit in small, reviewable batches rather than one large commit at the end.

## 7. Before delivering

Do both, in order, and do them before §8 rather than after — `direct` delivery lands on the base
branch immediately, so an unverified criterion is not a review comment, it is a bad commit on `main`.

1. **Walk the acceptance criteria one at a time.** For each, state met or not met and cite the
   evidence — the file and line, the test, or the command output. Do not batch-assert "all done".
2. **Run the repo's configured checks**, with the working directory set to the checkout you have
   been editing (the worktree, in worktree mode). Report failures honestly rather than summarising
   them away. If none are configured, find them in the project's own scripts and say which you ran.

Never claim a criterion is met when it is not.

## 8. Deliver

Ask the user before this step, every time. How finished work reaches the base branch is `delivery.mode` in the config, **not a decision you
make per session**. A project set to `direct` does not want a pull request, and opening one anyway
is not a helpful extra step — it is ignoring the configuration.

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" land          # dry run: what would happen
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" land --apply  # after the user confirms
```

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
