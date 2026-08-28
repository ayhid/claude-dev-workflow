---
name: dev-ingest-docs
description: Absorb an existing codebase's documentation into a verified map — inventory the docs, extract what they claim with evidence, find contradictions, ask for arbitration where evidence cannot settle it, and emit a map. Runs in steps across sessions. Use when joining a brownfield project, when /dev-init reports one, or when asked to understand, onboard onto, or digest a codebase and its docs.
argument-hint: "[optional: a topic to focus on]"
---

# /dev-ingest-docs — learn a codebase from what it already wrote down

For a **brownfield** project: years of decisions, some written down, some written down and no
longer true. The job is to end up with something a later session can trust, which is not the same
as a summary.

This runs in **steps and across sessions**. Every step persists. Stop after ten minutes and pick it
up next week; nothing is lost and nothing is re-derived differently.

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

## 2. The loop

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" ingest next
```

It gives you **one** document. Read that document — the whole thing — then:

**a. Extract its claims.** Write them to a scratch JSON file and record them:

```json
{
  "claims": [
    { "text": "Sessions are stored in Redis", "kind": "observable",
      "anchor": "src/session.ts:34", "source": "docs/architecture.md", "topic": "storage" },
    { "text": "Redis was chosen over Postgres for the TTL semantics", "kind": "intent",
      "source": "docs/architecture.md", "topic": "storage" }
  ],
  "questions": []
}
```

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" ingest record @<scratch>/claims.json
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" ingest read docs/architecture.md
```

**Verify before you record.** For every `observable` claim, open the anchor and confirm it says what
the document says. This is where the value is: the document is a hypothesis, the code is the
evidence, and a doc that has quietly become false is exactly what you are here to find.

**b. Record contradictions as questions, sparingly.** When the code contradicts a document, that is
not a question — the code wins, so record the true claim and note the stale document. Raise a
question only when evidence genuinely cannot settle it:

- two documents state different intents, and only a person knows which holds;
- a document states an intent the code appears to contradict, and you cannot tell whether the code
  is a bug or the doc is stale;
- something important is undocumented and unguessable — which of two systems is authoritative.

Every question must cite the claims behind it (`because`), and the tool refuses one that does not.
That is deliberate: a question with no claims behind it is a question the process invented, and a
survey that invents questions is an interview.

**c. Repeat.** `ingest next` moves to the following document. Batch nothing else in between.

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
