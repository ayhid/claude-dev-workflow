---
name: dev-ingest-docs
description: Absorb an existing codebase's documentation into a verified map — inventory the docs, extract what they claim with evidence, find contradictions, ask for arbitration where evidence cannot settle it, and emit a map. Runs in steps across sessions. Use when joining a brownfield project, when /dev-init reports one, or when asked to understand, onboard onto, or digest a codebase and its docs.
argument-hint: "[optional: a topic to focus on]"
---

# /dev-ingest-docs — learn a codebase from what it already wrote down

For a **brownfield** project: years of decisions, some written down, some written down and no
longer true. The job is to end up with something a later session can trust, which is not the same
as a summary.

## What this produces, and how it runs

What comes out is `_dev-workflow/artifacts/documentation/map.md` — every claim the project's docs
make, checked against the code that would prove or disprove it, grouped by topic, with the
contradictions and the questions still unsettled sitting right beside them. It never touches the
project's own documentation, not one line: reorganising it is a proposal you get at the end, in
chat, not something this skill does for you (§5).

It **runs in steps and across sessions.** Every step persists to a ledger *once it is recorded* —
stop after ten minutes and pick it up next week, and nothing recorded is lost or re-derived
differently. `dev.mjs ingest` with no arguments always says exactly where it stands. A subagent's
result that has not yet been recorded (§2) lives only in this session; stopping before it is
recorded means that one document gets read again, not lost.

Reading the documents is the slow part, so it now happens **in parallel** — one subagent per
document, dispatched a few at a time — rather than one document at a time in this session (§2).
Arbitration, emitting the map and proposing the reorg still happen here, with you.

## The rule that makes it worth doing

Every statement you record is a **claim**, and a claim carries its evidence:

| Field | What it is |
| --- | --- |
| `text` | one statement, not a paragraph |
| `kind` | `observable` or `intent` — see below |
| `anchor` | `file:line`, or the command that shows it. **Required for `observable`.** |
| `source` | the document it came from, or `derived` if you worked it out from the code |
| `topic` | the heading it belongs under |

**`observable`** — checkable against the tree. *"The commit hook is registered in
`.claude/settings.json`."* Somebody can verify it in ten seconds, and two of these disagreeing is a
contradiction you can locate.

**`intent`** — why something is the way it is. *"Worktree mode is the default so starting a ticket
never disturbs uncommitted work."* No amount of reading settles a disagreement between two of
these. A person has to.

The tool **refuses an `observable` claim with no anchor**, and it is right to. An unanchored claim
is a guess in the voice of a fact, and a map full of those reads exactly like one that was checked.
If you cannot anchor it, either find the evidence or record it as `intent` and name where the
belief came from.

## 0. Confirm the project is brownfield

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" assess
```

It prints each signal and a proposed verdict. If it says greenfield, say so and stop — there is
nothing to absorb, and `/dev-init` is the command they want.

## 1. Inventory

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" ingest scan
```

Lists every tracked document, hashes it, and creates the ledger. Safe to re-run at any point: a
document whose hash is unchanged keeps its read state, and one that changed comes back as pending
with its old claims marked stale rather than deleted.

Relay its scope to the user in one line before moving on — `scan`'s own output has the document
count, and a bare `dev.mjs ingest` right after it has the read/pending split (`sources: N (M read,
K pending)`), so this costs nothing extra: `Found N documents, all pending` on a first scan, or
`Found N documents; M already read, K pending` on a rescan.

## 2. Read the documents — in parallel

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" ingest next --all
```

`--all` returns every pending document in one call, not just the next one — the whole batch, ready
to hand to several readers at once instead of reading them here one at a time.

**a. Dispatch — one subagent per document, three at a time.** Work through the pending list in
batches of **at most three**. Three is deliberately conservative: enough that the fan-out is worth
doing, small enough that a sixty-document corpus does not open sixty subagents on the first breath.
Within a batch, dispatch one **fresh subagent per document** — never more than one document to a
subagent. That is not caution for its own sake: an unattended pass confabulates in proportion to how
much context it is reasoning over, not in proportion to how much work it is asked to do
(`docs/decisions/0002-retire-the-ci-posted-adversarial-reviewer.md`), and one document is the
smallest unit this job has.

Each subagent gets nothing but the document assigned to it and the claim rules above ("The rule
that makes it worth doing"). Its job, in its own isolated context:

1. Read the whole document.
2. Extract its claims — `text`, `kind`, `anchor`, `source`, `topic` — exactly as those rules say.
3. **Verify before it returns.** For every `observable` claim, open the anchor itself and confirm
   it says what the document says. This does not move to the coordinating session — a subagent that
   reports an anchor unchecked has skipped the one thing that makes a claim worth recording.
4. Return **only** a JSON object in its final message, nothing else around it:

```json
{ "claims": [ ... ], "questions": [ ... ] }
```

A subagent never runs `dev.mjs` itself, and never writes a file. That is what keeps the ledger
safe: `ingest record` writes the whole ledger back to disk unlocked, so two writers landing at once
could silently overwrite each other. One writer avoids the race outright — and that writer is you.

If no subagent tool is available, fall back to reading the documents one at a time in this
session — `ingest next`, without `--all`, still gives you the single next document exactly as
before.

**A question can only cite a claim that is already in the ledger.** Claim ids are assigned by
`ingest record` itself, in order, at the moment it runs — a subagent cannot know in advance what id
its own claim will get, so it can never correctly cite one of its own claims in the same JSON it
returns. If a document's own claims conflict with each other, have the subagent say so in plain
text alongside its claims rather than construct a `because` it cannot get right; write the question
yourself once that claim's real id comes back from recording it (below).

**b. Collect — one result at a time, never batched.** For each subagent's result, **in order, one
Bash call at a time — do not issue these as parallel tool calls**:

1. Write the subagent's returned JSON to `<scratch>/claims-<doc>.json` — its final message is the
   content of that file, not a command to run.
2. Record the claims first, alone if the subagent flagged no question, so their ids come back in
   the command's own output before anything else depends on them:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" ingest record @<scratch>/claims-<doc>.json
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" ingest read <path>
```

If the subagent also flagged a question about its own document, record its claims alone first,
read the ids back from `record`'s output, then record the question in a second `record` call citing
those real ids — never guessed ones. A question about an *earlier* document's claim already has a
real id sitting in the ledger and can go in the same batch as its own claims.

Same commands as before either way, just looped over a batch's results instead of run once.
Recording stays serial even though the reading happened in parallel: that is the whole reason the
unlocked ledger stays safe to leave unlocked.

**c. Record contradictions as questions, sparingly.** When the code contradicts a document, that is
not a question — the code wins, so record the true claim and note the stale document. Raise a
question only when evidence genuinely cannot settle it:

- two documents state different intents, and only a person knows which holds;
- a document states an intent the code appears to contradict, and you cannot tell whether the code
  is a bug or the doc is stale;
- something important is undocumented and unguessable — which of two systems is authoritative.

Every question must cite the claims behind it (`because`), and the tool refuses one that does not.
That is deliberate: a question with no claims behind it is a question the process invented, and a
survey that invents questions is an interview. That still holds with several subagents feeding the
same ledger — a question is checked against whatever is already recorded, regardless of which
subagent's batch it came from.

**d. Repeat, but check the phase, not just the pending list.** When a batch is fully recorded, take
the next three paths from the list `next --all` already gave you and dispatch again. When that list
is empty, run bare `ingest next` — reading is not necessarily done: a document that changed since it
was last read leaves its old claims `stale`, and `nextUnit` surfaces those as more extraction work
*before* it ever moves to arbitration. Reading is only actually finished once `next` itself reports
the arbitrate phase.

## 3. Arbitration

When the reading is done, `ingest next` switches to the open questions. **Put them to the user in
one message, at most five at a time**, each with the claims that produced it and the options you
can see. Then record each answer:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" ingest answer q3 "Postgres is authoritative; the cache is advisory"
```

Answers are permanent — a decision is never overwritten, only superseded by a new question — so ask
properly and record what they actually said, not a tidied version of it.

If they do not know, or want to check with someone, **leave it open**. An unanswered question is
published as unsettled, which is true and useful. A guessed answer is neither.

## 4. Emit

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" ingest emit
```

Writes `_dev-workflow/artifacts/documentation/map.md`: claims grouped by topic, each with its
anchor, plus the decisions and anything still unsettled. It is generated — regenerate it, never
edit it.

## 5. Propose the reorganisation. Do not perform it.

**This skill never rewrites the project's documentation.** Not one line. Everything it writes lives
under `_dev-workflow/artifacts/documentation/`.

What you produce at the end is a *proposal*, in chat: which documents are stale and what in them is
false, which two say the same thing, what is missing, what should move where. Cite the claim ids and
the anchors, so each one can be checked rather than taken on trust.

If the user wants it done, that is ordinary work — `/dev-task` it, so it goes through a ticket, a
branch and a review like any other change. Do not start editing their docs because the map made it
obvious what to fix.

## Stopping and resuming

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" ingest        # where it stands
```

Stop whenever. The ledger holds the sources, the claims, the questions and the answers, and it is
committed with the rest of `_dev-workflow/`, so a colleague picking it up gets the arbitration
decisions too — not just the map.

Two things worth saying out loud when you report progress: how many documents are left, and how many
claims turned out to contradict the code. The second number is the finding.
