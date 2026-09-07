---
name: dev-plan
description: Agree what done means for a tracker issue and how to get there — fetch it, restate its acceptance criteria against a stated bar, pick the target repo, propose the approach with the parts that are independent of each other named, and post the approved plan on the ticket. Edits no file, creates no branch or worktree, moves no ticket. Use when work on an issue is about to start, when /dev-task hands an ID here, or when the user types /dev-plan.
argument-hint: "[ISSUE-ID]"
---

# /dev-plan — from a ticket to an agreed plan, on the ticket

`$ARGUMENTS` is an issue ID (`ABC-398`, `#42`). If it is a sentence instead, the issue is not filed
yet: send it to `/dev-file` and stop. If it is empty, ask which issue, and stop.

**Planning is not starting.** This skill ends with the plan posted on the ticket as a comment,
where the next session — or the next skill — reads it back with `fetch`. It never edits a file,
never creates a branch or worktree, and never moves the ticket. `/dev-build <ID>` is the step that
starts work, and it is the user's to invoke.

## 0. Load the project's workflow config

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" config
```

Gives the ticket language, the repo layout and its routing rules, the `tdd:` line, and the check
commands. **Everything below that says "the configured X" comes from here** — do not carry
conventions over from another project. If it reports `MISSING`, run `/dev-init` first and stop.

## 1. Fetch the issue

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" fetch $ARGUMENTS
```

If the script exits non-zero, report its message and stop — do not guess at the ticket contents.

Read the **whole** output, comments included. Tickets migrated from another tracker often carry
their real requirements in the comment thread rather than the description, with the original author
quoted inside the comment text rather than being the comment author.

Two things in it change what you do:

- **A `## Plan` comment already exists.** This ticket was planned before. Show it and ask whether
  to keep it (then stop and point at `/dev-split` or `/dev-build`) or revise it (then continue —
  the new comment supersedes the old, and says so in its first line).
- **A `## Sub-issues` section exists.** This ticket was already split. Say so and point at
  `/dev-build $ARGUMENTS`; there is nothing to plan at this level.

## 2. Restate the acceptance criteria

Write the criteria back as an explicit checklist:

```
- [ ] AC1: …
- [ ] AC2: …
```

If the ticket states criteria, quote them faithfully — do not silently widen or narrow scope. Hold
each to the bar `/dev-file` files against: falsifiable, naming the evidence that would show it met,
checkable without a judgement call. A criterion that fails the bar is not rewritten in silence: say
which, propose the falsifiable form, and get it confirmed.

If the ticket has **no** criteria, draft them from the description and comments, mark the block
clearly as `DRAFT — please confirm`, and **stop until the user confirms or corrects them**.
Everything downstream is verified against this list, so a wrong list means wrong work.

## 3. Decide the target repo

If the config lists `repos`, route by their `when` rules and state which you picked and why.
Sibling directories with their own `.git` are **separate repos** — a branch lives in exactly one of
them. If the ticket genuinely spans several, say so: that is a reason to split it, with one unit per
repo, and the units name their repo.

If no repos are configured, the project is a single repo at its root.

## 4. Propose the plan and wait

Short, and concrete: the files to touch, the approach, the risks, and how each acceptance
criterion will be tested — by which test, or by which command's output when no test can observe it.

Then the one thing this skill adds over a plan in a chat: **name the parts that are independent of
each other**. Two parts are independent when the files they touch do not overlap and neither's
criteria need the other's code to exist. Say which criteria each part would own, and which parts
must wait for another. That is what `/dev-split` turns into work units, and what tells the user
whether splitting is worth it at all.

**Wait for explicit approval.** Revise until it is approved; do not touch a file meanwhile.

## 5. Post the plan on the ticket

The plan lives on the ticket, not in this session — a later session, a builder subagent and
`/dev-split` all read it back from `fetch`. Write it to a scratch file, the body starting with the
literal heading `## Plan`, then:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" update $ARGUMENTS comment @<scratch>/plan.md
```

The body, in the configured ticket language, in this order:

```markdown
## Plan
### Criteria
- [ ] AC1: …            (the list §2 agreed, verbatim)
### Approach
### Independent parts    (or: "None — one unit", when nothing can be built apart)
- Part A: files, criteria owned, depends on
### Risks
### Verification
```

Confirm the comment landed — `fetch` again prints it back — before saying so.

## 6. Say what comes next

One line, one of two:

- Two or more independent parts → `Next: /dev-split $ARGUMENTS — file the parts as work units and
  build them side by side.`
- Otherwise → `Next: /dev-build $ARGUMENTS — start the work.`

Do not run either yourself.
