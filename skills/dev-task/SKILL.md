---
name: dev-task
description: Start work on a tracker issue, or on a plain sentence describing what you want — the entry point that routes to the step the work is at: file the issue when there is none, agree criteria and a plan, split it into work units when the plan has independent parts, then build. Use when the user starts work on a ticket, describes something they want built, or types /dev-task.
argument-hint: "[ISSUE-ID or a sentence describing the work]"
---

# /dev-task — the front door

`$ARGUMENTS` is **either** an issue ID (`ABC-398`, `#42`) **or** a sentence describing what you want
("add a dark mode toggle", "the CSV export times out on big accounts"). If it is empty, ask what
they want to work on, and stop.

The ID shape is the project's, not a guess: `dev.mjs config` reports the provider, and IDs are
`ABC-398` on YouTrack and `#42` on GitHub.

This skill decides nothing about the work itself. Each step below is its own skill, ends at a
durable artefact on the tracker, and can be run on its own in a later session — an issue ID, a
`## Plan` comment, a set of sub-issues, delivered branches. This one only says which comes next,
so that "let's work on #42" is still one command.

## 0. Load the project's workflow config

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" config
```

If it reports `MISSING`, run `/dev-init` first and stop.

## 1. A sentence — file it first

Follow `/dev-file` with the sentence. It orients in the code, asks for what is missing in rounds
the user can stop after, checks for duplicates, drafts in the project's language with falsifiable
acceptance criteria, and files on approval. It ends at `Filed <ID> — <title>`.

Then continue from §2 with that ID — unless the user said they only wanted it filed, in which
case stop there.

## 2. An ID — plan it

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" fetch <ID>
```

Read what is already on the ticket, because the step is decided by what is there:

- **No `## Plan` comment** → follow `/dev-plan <ID>`. It agrees the criteria, picks the repo,
  proposes the approach with its independent parts named, and posts the plan on the ticket. It
  ends by naming the next step.
- **A `## Plan` comment and no `## Sub-issues`** → the plan is agreed. If it names two or more
  independent parts, offer `/dev-split <ID>` in one line and follow the answer; otherwise go to §3.
- **A `## Sub-issues` section** → it is split. Go to §3.

## 3. Build it

Follow `/dev-build <ID>`. One unit is built here — worktree, `/dev-tdd` when the project has it
on, criteria walked with evidence, delivered the way the project delivers. A split ticket has its
ready units built by one `dev-builder` subagent each and landed a wave at a time.

`/dev-build` asks before it delivers, every time. Do not skip past that on its behalf.

## What this skill refuses

Nothing here edits a file, creates a branch or moves a ticket before `/dev-build` §3 — every
earlier step ends with something on the tracker and nothing on disk. Each step is the user's to
skip or stop at; a sentence that only wanted a ticket filed gets a ticket filed.
