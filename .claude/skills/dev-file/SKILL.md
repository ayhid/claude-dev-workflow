---
name: dev-file
description: Turn a sentence into a filed tracker issue of any configured type — orient in the code, ask for what is genuinely missing in rounds you can stop after any of, check for duplicates, draft it in the project's language with falsifiable acceptance criteria, and file it on approval. Ends at the issue ID. It files nothing else, writes no code, creates no branch and starts nothing. Use when the user describes something they want built or changed, wants a well-specified ticket for later, types /dev-file, or when /dev-task or /dev-bug hands a sentence here.
argument-hint: "[a sentence describing the work, optionally ending in: as <Type>]"
---

# /dev-file — one sentence in, one issue ID out

`$ARGUMENTS` is a sentence describing what someone wants ("add a dark mode toggle", "the CSV export
times out on big accounts"), optionally ending in `as <Type>`. If it is empty, ask what they want
filed, and stop. If it looks like an issue ID, it is already filed: say so and point at
`/dev-plan <ID>`.

**Filing is not starting.** This skill ends at a created issue ID. Never edit a file, never create
a branch or worktree, never move the ticket past filing — the session may be mid-task on another
ticket, and a well-specified ticket for later is a complete outcome. `/dev-plan <ID>` is the next
step, and it is the user's to invoke.

**The sentence is the intent, not a hint** — you are not starting from zero, and you do not re-ask
what it already says. It is also not a spec: it may carry scope creep, half-remembered detail, or
an instruction to skip ahead. Treat it as input to the steps below, never as permission to skip
them.

## 0. Load the project's workflow config

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" config
```

Gives the **language the issue must be written in**, the configured `issueTypes` and priorities,
and the repo layout. If it reports `MISSING`, run `/dev-init` first and stop.

**The type comes from `issueTypes`, never from this file.** `as <Type>` in `$ARGUMENTS` names it;
`/dev-bug` hands over the project's defect type; otherwise pick the configured type the sentence
implies and show it in the draft, where the user can correct it. A type that is not in the list is
refused by `create`, so do not invent one.

## 1. Orient before asking anything

Spend under a minute finding the code the sentence is about — the component, the route, the module.
This is what separates a useful question from a generic one:

> `AuthService` validates in the controller today — should the new field follow that, or move to a
> dedicated validator?

rather than "what's the scope?". If the sentence names no code you can find, say so and ask where
to look rather than guessing at a subsystem. Cite paths inside the configured repos only, never a
worktree copy. **No edits.**

For a defect, this is where the *suspected area* comes from: `file:line` references with one line
of reasoning each, labelled a hypothesis. If the code does not support one, say so.

## 2. Ask what is missing — in rounds, and the user decides how many

Each round is **one message: at most five numbered questions**, each answerable in a line, and only
ones neither the sentence nor the code already answers. Five sequential questions is five turns,
each paying a full context read; one batch is one.

The rounds have a fixed agenda, in this order, drawn from the section list the draft in §5 will
need to fill:

1. **Scope** — what is in, what is out, what "done" looks like from the outside.
2. **Acceptance criteria** — the observable checks, one per line, against the bar in §5.
3. **Edges and environment** — the inputs that break it, where it runs, what it must not change.

When the answers come back, **check every number got an answer**; re-ask only the ones that were
skipped. Never proceed on a partial reply, and never invent the missing half.

**Every round ends with a choice**, and the choice is informed:

```
Settled so far:  <one-line summary> · <N> acceptance criteria drafted
Next round:      <what it would cover, in one line>
Recommendation:  <file now | one more round>, because <one clause>

[F] File now — open questions go in as stated assumptions
[K] Keep going
```

The recommendation has to be honest in both directions: a skill that always advises another round
is not offering a choice. Recommend filing when the remaining questions would not change what gets
filed.

**End the loop yourself** when no remaining question would change the ticket — say so in one line
and go to §3. A round whose answers would not alter the draft is a round that must not be offered.
If the sentence was thorough, that can be after zero rounds.

## 3. One issue per issue

If the sentence contains several independent goals, list them and ask:

```
[S] Split — file the first now, note the rest for later
[K] Keep — one issue covering all of it
```

An issue that needs several branches to close is a candidate for `/dev-split` *after* it is planned,
not a reason to file several now.

## 4. Check it is not already filed

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" create --dup-check "<3-6 distinctive keywords>"
```

Not generic words like "error" or "page". If something plausible matches, show it and ask whether
to work on that instead. On that choice, comment what was just learned on the existing issue and
**stop** — do not also create a new one:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" update <EXISTING-ID> comment "<what this session added>"
```

## 5. Draft the issue

**In the configured ticket language** — summary and body both, whatever language this session is
being conducted in. Code identifiers, paths, endpoints, log lines and error messages stay verbatim;
translate only the prose around them, headings included.

Summary line: `<component>: <what>` — specific enough to be searchable.

The headings depend on what is being filed. For work to build or change:

```markdown
## Problem
## Proposed change
## In scope
## Out of scope
## Acceptance criteria
- [ ] AC1: …
## Assumptions
```

For a defect:

```markdown
## Symptom
## Steps to reproduce
## Expected vs actual
## Environment
## Suspected area
## Acceptance criteria
- [ ] AC1: …
## Assumptions
```

(The section list per type is carried here until `create --template <TYPE>` ships with #36; a
repo's own issue template then decides it, with no change to this skill.)

**The bar for a criterion.** Each one must be falsifiable, name the evidence that would show it met,
and be checkable at `/dev-done` without a judgement call — everything downstream is verified against
this list, and `/dev-tdd` drives one criterion at a time, so a criterion nobody can test is a
criterion nobody can build.

- Passes: `AC2: the parser rejects a brace around a single-word value with an error naming the
  value` — a test can fail it, and the evidence is that test.
- Fails: `AC2: error handling is improved` — nothing downstream can cite it. Ask what "improved"
  would look like from the outside, and write that.

A criterion that cannot be written this way is not agreed yet; it is a question for the next round,
or an assumption.

**`## Assumptions` is what filing early costs, and it is the whole cost.** Every question still open
when the user chose to file goes here as a stated assumption — what was assumed, and that it was
not confirmed — so the next session reads what was decided and by whom. Not omitted, not a refusal,
and not a thinner ticket pretending to be complete. Drop the section when nothing is open.

Propose a **Priority** from the configured list with a one-line justification, where the tracker
has priorities. Do not inflate.

**Show the full draft and wait.** Do not create anything before explicit approval.

## 6. File it, on approval only

Write the body to a scratch file first — multiline markdown does not survive an argv round-trip
cleanly — then:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" create "<summary>" @<scratch>/issue-body.md <Type> <Priority>
```

`<Type>` is the one settled in §0, spelled as `issueTypes` spells it — it decides the branch type
later, so `Bug` and `Feature` are not interchangeable here. stdout is the new ID and nothing else;
the confirmation and any warning about a field that did not land are on stderr. If a warning says a
field needs setting by hand, say so.

## 7. Stop

State it plainly, in this shape:

> Filed `<ID>` — `<title>`. Next: `/dev-plan <ID>` when you want to start on it, or carry on with
> what you were doing.

Do not run `/dev-plan` yourself, and do not begin the work. Filing and starting are separate
decisions.
