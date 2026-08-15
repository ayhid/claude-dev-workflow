---
name: yt-task
description: Start work on a YouTrack issue — fetch it, agree acceptance criteria, plan, move it to the in-progress state, branch, and implement with ticket-referencing commits. Use when the user starts work on a ticket or types /yt-task.
argument-hint: [ISSUE-ID]
---

# /yt-task — start work from a YouTrack issue

`$ARGUMENTS` is the issue ID, e.g. `ABC-398`. If it is empty, ask for one and stop.

## 0. Load the project's workflow config

```bash
node "${CLAUDE_PROJECT_DIR}/_youtrack/scripts/yt.mjs" config
```

This prints the instance, project, ticket language, state ladder, branch and commit patterns,
per-repo routing and check commands. **Everything below that says "the configured X" comes from
here** — do not carry conventions over from another project.

If it reports `MISSING`, run `/yt-init` first and stop.

Then reconcile the board before trusting any state you are about to read:

```bash
node "${CLAUDE_PROJECT_DIR}/_youtrack/scripts/yt.mjs" sync
```

Dry run — it reports drift and changes nothing. A ticket sitting in the review state with a merged
PR simply means nobody has run this since the merge, not that the work is unfinished.

## 1. Fetch the issue

```bash
node "${CLAUDE_PROJECT_DIR}/_youtrack/scripts/yt.mjs" fetch $ARGUMENTS
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

## 5. Move the ticket to the configured start state

```bash
node "${CLAUDE_PROJECT_DIR}/_youtrack/scripts/yt.mjs" update $ARGUMENTS "State <configured states.start>"
```

The script prints the state it reads back afterwards. Confirm that line reports the state you
asked for — YouTrack can return 200 for a command it did not apply, so the read-back is the
actual check. Use only state names from the configured ladder, and **brace a state name only when
it contains a space** — `State {In Review}` is correct, `State {Staging}` is rejected outright with
`expected: {Staging}`. Braces mark where a multi-word value ends; they are not quoting.

## 6. Create the branch

Confirm the base branch first, then branch from it:

```bash
git -C <repo> branch --show-current      # confirm you are on the intended base
git -C <repo> switch -c <branch per the configured pattern>
```

The default pattern is `<ID>-<slug>`, where `<slug>` is three to five kebab-case words —
e.g. `ABC-398-redirect-301-map`. Never branch off another ticket's branch by accident: check
what you are on before switching.

## 7. Implement

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

When you open a PR, reconcile the ticket in the same breath — it is part of opening the PR, not a
separate decision. The reconciler reads the open PR and moves the ticket to the configured
**review** state itself:

```bash
node "${CLAUDE_PROJECT_DIR}/_youtrack/scripts/yt.mjs" sync --apply
```

It matches PRs to issues through the branch name, so a branch named per the configured pattern is
what makes this work. If it reports no drift, say so and post the link by hand instead:

```bash
node "${CLAUDE_PROJECT_DIR}/_youtrack/scripts/yt.mjs" update $ARGUMENTS "State <configured states.review>" "<PR opened: url>"
```

Request the configured reviewer, and push to every remote listed for that repo. Verify the PR body
and reviewer actually landed after creating it — `gh pr create` can report a failure for a PR it in
fact created, leaving it with the commit message as its body and no reviewer attached.

## 8. Before declaring done

Do all three, in order:

1. **Walk the acceptance criteria one at a time.** For each, state met or not met and cite the
   evidence — the file and line, the test, or the command output. Do not batch-assert "all done".
2. **Run the repo's configured checks**, and report failures honestly rather than summarising
   them away. If none are configured, find them in the project's own scripts and say which you ran.
3. **Ask the user** whether to close the ticket. Only on their confirmation:

```bash
node "${CLAUDE_PROJECT_DIR}/_youtrack/scripts/yt.mjs" update $ARGUMENTS comment "<summary>"
node "${CLAUDE_PROJECT_DIR}/_youtrack/scripts/yt.mjs" sync --apply
```

Never run the closing transition unprompted, and never claim a criterion is met when it is not.
`/yt-done` does this same close-out and re-verifies from scratch — prefer it when the work spanned
more than one session.
