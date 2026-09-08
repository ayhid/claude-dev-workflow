---
name: dev-bug
description: Capture something broken as a tracker issue — parse the symptom, investigate the likely code path to a suspected area, then hand it to /dev-file to grill, dup-check, draft and file it as the project's defect type. Never fixes, never edits a file, never creates a branch. Use when the user types /dev-bug or describes something broken mid-session.
argument-hint: "[free-form description of the problem]"
---

# /dev-bug — something is broken; get it on the tracker

`$ARGUMENTS` is a free-form description. If it is empty, ask what broke and stop.

**Filing is not fixing.** This skill ends at a created issue ID. Never start the fix, never edit a
file, never switch branches — the session may be mid-task on another ticket. This holds in
worktree mode too: that a checkout *could* be made without disturbing anything is not a reason to
make one. `/dev-task <ID>` is the step that starts work, and it is the user's to invoke.

There is one filing path in this workflow, `/dev-file`, and this skill is its front door for
defects: it adds the two things a bug report needs that a feature request does not — a parsed
symptom and a suspected area in the code — and hands both over. The grill, the duplicate check,
the draft and the `create` live there, once.

## 0. Load the project's workflow config

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" config
```

Gives the **language the issue must be written in**, the configured `issueTypes` — the one this
project uses for defects is what `/dev-file` will file as — and the repo layout. If it reports
`MISSING`, run `/dev-init` first and stop.

## 1. Parse what you were given

Extract, without inventing: the symptom, where it happens (URL, component, command), any error
message, and when it started if mentioned. Note what is missing rather than filling gaps.

## 2. Investigate before asking

Bounded effort — a handful of searches and reads, **no edits**:

- search for the verbatim error message, then for the component or route name;
- `git -C <repo> log --oneline -10 -- <suspect path>` on whatever the search surfaces.

Cite paths only inside the repos the config lists (or the project root if it lists none). A
project with sibling repos or checked-out worktrees will return the same file many times from a
root-level search — cite the mainline path, never a worktree copy.

Produce a **Suspected area** with `file:line` references and one line of reasoning each. Label it
a hypothesis. If the code does not support one, say so — a wrong lead costs more than none.

## 3. Hand it to `/dev-file`

Follow `/dev-file` from its §2 with three things settled already, so it does not redo them:

- the type: the project's defect type, from `issueTypes`;
- the parsed symptom from §1, as the answers to whatever its first round would have asked;
- the suspected area from §2, verbatim, for the draft's `## Suspected area`.

Its rounds then ask only what is still missing — reproduction steps, expected versus actual,
environment, frequency, whether it is a regression — informed by §2: "the 500 comes from
`ExportJob.run` at line 88; does it fail for every account or only large ones?" beats "what are
the steps to reproduce?". It checks for duplicates, drafts with the defect headings, files on
approval, and ends at the ID.

One addition for a bug filed mid-session: the draft's last section, `## Session context`, is one
line on what was being worked on when this surfaced.

## 4. Stop

`/dev-file` ends with `Filed <ID> — <title>`. Repeat it, and do not run `/dev-task` or begin the
fix. Filing and fixing are separate decisions.
