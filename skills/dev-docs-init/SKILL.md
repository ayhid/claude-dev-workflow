---
name: dev-docs-init
description: Scaffold a greenfield project's documentation — create the architecture, domain, operations, testing and security documents, then fill them a claim at a time, each line carrying the evidence that would show it false. Use when a new project has no documentation yet, when /dev-init reports greenfield, or when the user types /dev-docs-init.
argument-hint: "[optional: one document key, e.g. architecture]"
---

# /dev-docs-init — the documentation skeleton, for a project that has none

`/dev-ingest-docs` reads an existing project's documentation. `/dev-adr` records one decision.
Neither helps the project that has **nothing written down yet**, which is what this is for.

It is the same machinery pointed the other way: **ingest turns documents into claims, this turns
claims into documents.** One ledger, one validator, one renderer.

## The rule that makes it worth doing

"Read the repo and write the docs" produces prose nobody can falsify. Six months later no one can
tell which sentences are still true, so the whole artifact rots at the speed of its worst line.

So you do not write documents here. You record **claims**, and the command renders them:

| Field | What it is |
| --- | --- |
| `text` | one statement, not a paragraph |
| `kind` | `observable` or `intent` |
| `anchor` | `file:line`, or the command that shows it. **Required for `observable`.** |
| `source` | who asserted it. **Required for `intent`** — on a new project this is usually the user |
| `target` | which document it belongs in |
| `topic` | the heading it sits under |

`renderDocument` has no parameter a paragraph could be passed through, so an unfalsifiable sentence
is not discouraged here, it is **unrepresentable**. Two refusals you will meet, and both are right:
an `observable` claim with no anchor, and an anchor naming a file that is not in the repo.

**On a two-week-old project most of what you record will be `intent`, attributed to the user, with a
minority of anchored `observable` claims. That is the correct output, not a degraded one** — six
months later a reader can tell which sentences were ever checkable and which were one person's
belief on a Tuesday. Do not pad it out with confident prose to make it look finished.

## 0. Check the stage, and the set

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" docs
```

Prints each document in the project's `docs.set`, whether it exists, and how many claims back it.

`docs init` **refuses** on a project configured `brownfield` — run `/dev-ingest-docs` instead — and
refuses when nobody has settled the stage at all, naming `/dev-init`. Neither is inferred: a wrong
stage sends this down the wrong branch and nothing downstream would notice.

## 1. Scaffold

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" docs init
```

Creates only the documents that do not exist, names every path it writes, and never touches a file
that is already there. Safe to re-run. `--only architecture,testing` narrows it.

Decision records are a **pointer**, not a file this writes: it prints `/dev-adr`, which numbers and
freezes them properly.

Each document is a stub until claims are recorded against it, and `docs check` fails while it is one.

## 2. Read the code, then ask

**a. Orient first, in the code.** Spend a few minutes finding the entry point, the modules, the
tests, the deploy path. Every `observable` claim you record has to be anchored to something you have
actually opened, so this is not optional preparation — it is where the claims come from.

**b. Ask what the code cannot tell you, as a numbered list.** At most five questions, in one
message, per document. The good ones are about intent, because that is the half no amount of reading
settles:

> `AuthService` validates in the controller rather than in a validator — was that deliberate, or is
> it just where it landed?

rather than "what is the architecture?". When they answer, check every number got an answer and
re-ask only the ones that did not. Their words become the `source` of an `intent` claim, so record
what they actually said, not a tidied version.

## 3. Record

Write the claims to a scratch file and record them. Each one names its `target`:

```json
{
  "claims": [
    { "text": "The HTTP entry point is src/server.ts", "kind": "observable",
      "anchor": "src/server.ts:12", "target": "architecture", "topic": "shape" },
    { "text": "Sessions are in memory because the service is single-instance for now",
      "kind": "intent", "source": "ayoub", "target": "architecture", "topic": "storage" },
    { "text": "Nothing is tested below the HTTP layer, deliberately, until the shape settles",
      "kind": "intent", "source": "ayoub", "target": "testing", "topic": "coverage" }
  ]
}
```

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" docs record @<scratch>/claims.json
```

**Verify every anchor before you record it.** Open the file, confirm the line says what the claim
says. A claim that reads as checked and is not is worse than no claim, because it reads exactly like
one that was.

Record what is genuinely unsettled as a question through `ingest record` — it takes `questions`,
each citing the claims behind it — and it prints under **Not yet established** in the document
rather than being quietly left out.

## 4. Render, and check

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" docs render
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" docs check
```

`render` rewrites each document from the ledger. `check` exits non-zero when one is still a stub,
when the ledger has moved on, or when somebody edited a document by hand.

These documents are **generated, and they say so**. Change one by re-recording its claim and
re-rendering, never by editing the file — `render` refuses to overwrite a hand-edit rather than
discarding it, and `dev.mjs ingest scan` is what absorbs one back into the ledger.

`docs check` is worth putting in CI once the documents are real.

## What this will not do

- **It never rewrites a document that already exists.** A project with hand-written docs is
  `/dev-ingest-docs`'s job.
- **It writes no prose of its own.** Every line is a claim you recorded.
- **It does not decide the stage.** `dev.mjs assess` proposes; a person settles it in the config.
