---
name: dev-bug
description: Capture a bug as a tracker issue — investigate the likely code path, check for duplicates, draft the issue, and file it on approval. Use when the user types /dev-bug or describes something broken mid-session.
argument-hint: [free-form description of the problem]
---

# /dev-bug — file a bug in the tracker

`$ARGUMENTS` is a free-form description. If it is empty, ask what broke and stop.

**Filing is not fixing.** This skill ends at a created issue ID. Never start the fix, never
edit a file, never switch branches — the session may be mid-task on another ticket. This holds in
worktree mode too: that a checkout *could* be made without disturbing anything is not a reason to
make one. `/dev-task <ID>` is the step that starts work, and it is the user's to invoke.

## 0. Load the project's workflow config

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" config
```

Gives the project key, the **language the issue must be written in**, the valid issue types and
priorities, and the repo layout. If it reports `MISSING`, run `/dev-init` first and stop.

## 1. Parse what you were given

Extract, without inventing: the symptom, where it happens (URL, component, command), any
error message, and when it started if mentioned. Note what is missing rather than filling gaps.

## 2. Investigate before asking

Bounded effort — a handful of searches and reads, **no edits**:

- search for the verbatim error message, then for the component or route name;
- `git -C <repo> log --oneline -10 -- <suspect path>` on whatever the search surfaces.

Cite paths only inside the repos the config lists (or the project root if it lists none). A
project with sibling repos or checked-out worktrees will return the same file many times from a
root-level search — cite the mainline path, never a worktree copy.

Produce a **Suspected area** with `file:line` references and one line of reasoning each.
Label it a hypothesis. If the code does not support one, say so — a wrong lead costs more
than none.

## 3. Ask only the gaps

At most **5 questions, in one batch, numbered**, and only ones neither the description nor the code
answers. Draw from: exact reproduction steps, expected vs actual, environment (local/staging/
prod, browser, runtime version), frequency (always/intermittent), regression or new, severity and
impact, relevant data (payload, account, record).

Ask them informed by §2 — "the 500 comes from `ExportJob.run` at line 88; does it fail for every
account or only large ones?" beats "what are the steps to reproduce?".

When the answers come back, **check every number was answered**, and re-ask only the ones that were
not. Do not proceed on a partial reply and do not fill the gaps yourself.

Skip anything already known. If the description was thorough, ask nothing and say so.

## 4. Check for duplicates

Pick 2–3 distinctive keywords from the symptom — not generic words like "error" or "page":

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" create --dup-check "<keywords>"
```

If plausible matches come back, show them and ask whether to comment on the existing issue
instead. On that choice, comment and stop — do not also create a new issue:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" update <EXISTING-ID> "comment" "<what we just observed>"
```

## 5. Draft the issue

**Write it in the configured ticket language** — summary and description both, whatever language
this session is being conducted in. The ticket is read by the team in the tracker, not by this
session. Keep code identifiers, file paths, endpoints, log lines and error messages verbatim in
their original language; translate only the prose around them.

Summary line: `<component>: <symptom>` — specific enough to be searchable, e.g.
`Router plugin: 500 on nested slug resolution`.

Description, in this order (translate the headings too):

```markdown
## Symptom
## Steps to reproduce
## Expected vs actual
## Environment
## Suspected area
## Session context
```

`Suspected area` carries the file refs and reasoning from step 2, marked as hypothesis.
`Session context` is one line on what was being worked on when this surfaced.

Propose a **Priority** from the configured list with a one-line justification. Default to the
configured default unless impact argues otherwise; do not inflate.

**Show the full draft and stop.** Do not create anything before explicit approval.

## 6. Create it, on approval only

Write the description to a scratch file first — multiline markdown does not survive an argv
round-trip cleanly — then pass it with `@`:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" create "<summary>" @<scratch>/bug-body.md Bug <Priority>
```

Type and Priority must come from the configured lists. The script prints only the issue ID on
stdout; a `created ABC-… (Type=… Priority=…)` line on stderr confirms the fields landed. If
that line reports a failure, say so — the issue exists but its fields need setting by hand.

Then confirm, verbatim in shape:

> Created ABC-XXX — run `/dev-task ABC-XXX` to start on it, or continue what you were doing.

## 7. Stop

Do not run `/dev-task` yourself, and do not begin the fix. Filing and fixing are separate decisions.
