---
name: dev-adr
description: Record an architecture decision as an ADR — draw out the options that were rejected and why, write the record, and freeze it. Use when a decision gets made mid-session, when the user types /dev-adr, or when asked why something is the way it is.
argument-hint: "[the decision, in a sentence] | list | <N>"
---

# /dev-adr — write down a decision while the alternatives are still known

`$ARGUMENTS` is one of:

- **a sentence** describing a decision → §1, and the rest of this skill runs against it.
- **`list`** → run `dev.mjs adr list` and print it. Nothing else. Stop.
- **a number** → read that record and answer questions about it. Do not edit it.
- **empty** → ask what was decided, and stop.

## What this is for, and what makes it worth the minutes

An ADR is not a summary of the system. `architecture.md` says what the shape *is*; an ADR says
**which alternatives were rejected and on what grounds**. That section is the entire reason the
format exists, and it is the one people skip, because at the moment of deciding the rejected
options feel obvious and not worth writing. Six months later they are neither.

So the job here is not "create a file". It is to get the options out of the user's head before
they evaporate. **If you finish with an ADR whose Options section lists one option, you have
written a commit message in a more expensive format.**

## 0. Load the project's workflow config

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" config
```

If it reports `MISSING`, run `/dev-init` first and stop.

Records live in `docs.decisionsDir` — `docs/decisions` unless the project says otherwise. You do
not need to know the path: every command below resolves it.

## 1. Check it is not already decided

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" adr list
```

Read the titles. Three outcomes, and they are different:

- **Nothing related** → §2.
- **A `proposed` record covers it** → that is this decision, still being written. Continue it
  rather than opening a second one.
- **An `accepted` record covers it and the user is changing it** → this is a **supersede**, not a
  new record. Skip to §5.

## 2. Draw out the options — the part that cannot be skipped

Ask, in one message, at most four questions. The wording matters less than getting these three
things:

1. **What forced the decision.** The constraint, not the history. "We need session state to expire
   on its own" — not "we were discussing storage".
2. **What else was on the table.** Push here. "Was anything else considered?" gets "no"; "what was
   the obvious alternative, and what was wrong with it?" gets an answer. If they genuinely
   considered nothing else, name a plausible alternative yourself and ask why it was not chosen —
   the answer *is* the rationale, and without it the record explains nothing.
3. **What it costs.** Every decision forecloses something. A Consequences section that lists only
   benefits is a sales pitch and ages badly.

Do not proceed on a partial reply. A record missing its rejected options is the failure mode this
whole skill exists to prevent, and it is cheaper to ask twice now than to reconstruct it never.

## 3. Scaffold the record

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" adr new "<the decision, as the choice made>"
```

Title it as **the choice**, not the topic: *"Redis for session state"*, not *"Session storage"*.
A list of topics tells a reader nothing; a list of choices is a changelog of the architecture.

It prints the path and creates the record as `proposed`, which is editable. Fill in the three
sections by editing that file:

- **Context** — the constraint that forced a decision.
- **Options considered** — every option as `- **<option>** — <why not>`, and the chosen one marked
  `**(chosen)**` with why it won.
- **Consequences** — what this makes easy, what it makes expensive, what it forecloses.

Write what was actually said. Do not smooth a real trade-off into a neutral summary; the sharp
version is the useful one.

## 4. Show it and freeze it

Show the finished record and ask whether it is right. On approval:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" adr accept <N>
```

**From here the record is immutable**, and `hooks/check-adr-immutable.sh` refuses edits to it. That
is the point: an ADR records what was known at a moment, and editing it rewrites that moment while
every citation of its number carries on pointing at the file.

If the decision was argued and turned down, `adr reject <N>` instead. Keep the record — a rejected
proposal is a record of an argument already had, and deleting it invites the argument again.

## 5. Superseding an existing decision

Never edit an accepted record, and never work around the hook. Run:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" adr supersede <N> "<the new decision>"
```

It writes the new record, points the old one at it, and points the new one back. Then fill in the
new record as in §3 — and in its Context, say what changed since the old decision. "Redis, but the
persistence guarantees turned out to matter" is the sentence a future reader needs; "we now use
Postgres" is not.

Accept it as in §4.

## 6. Cite it from the code

An ADR nobody finds is an ADR nobody wrote. At the choke point the decision constrains, leave the
number:

```js
// see docs/decisions/0007 — worktrees, not branch switching
```

This is the backlink that matters, because the place a reader needs the reasoning is the code, not
the docs directory. One line, at the one place the constraint actually bites — not on every file
that touches the subject.

## What not to do

- **Do not write an ADR for every change.** A decision worth a record is one where a reasonable
  person would have chosen differently. Renaming a variable is not one.
- **Do not edit an accepted record**, including to fix its prose. Supersede it.
- **Do not renumber or delete records.** The number is a permanent address; `0003` must keep
  meaning what it meant, or every citation of it silently reparents.
- **Do not hand-edit the index.** `adr index` regenerates it, and every command already does.
