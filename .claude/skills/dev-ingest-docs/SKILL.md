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
contradictions and the questions still unsettled sitting right beside them. Beside the map, the
ledger records what each document still is (§3), which two say the same thing or disagree (§4), and
where each one goes in the documentation the project should have (§7) — and `reorg rewrite`
assembles that as a **staged draft** under `_dev-workflow/artifacts/reorg/`. It never touches the
project's own documentation, not one line: applying the draft is separate work you approve file by
file (§7).

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
with its old claims marked stale rather than deleted. A document deleted from disk is `gone` and
keeps its claims; one still on disk that no longer counts as documentation — a vendored skill pack,
say — is `excluded`, its claims with it, and neither is reported again on the next scan.

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
4. Note the document's **enrichment** too, since it is already read: a `summary` (3-5 sentences),
   5-10 `keywords`, and `headings` — the `#`/`##`/`###` lines, verbatim. One pass, not two; §3 uses
   this to classify relevance without re-reading every document.
5. Return **only** a JSON object in its final message, nothing else around it — **no `questions`
   field**: a question needs a claim id, ids are assigned by `ingest record` at the moment it runs,
   and a subagent never sees the ledger to learn one, so it can never write a valid `because`. If
   two of a document's own claims conflict, name that in `conflicts` by **position** in this same
   `claims` array instead:

```json
{
  "claims": [ ... ],
  "conflicts": [ { "about": [0, 2], "text": "claim 0 and claim 2 disagree about X" } ],
  "summary": "...",
  "keywords": [ ... ],
  "headings": [ "## Storage", "## Auth" ]
}
```

A subagent never runs `dev.mjs` itself, and never writes a file. That is what keeps the ledger
safe: `ingest record` writes the whole ledger back to disk unlocked, so two writers landing at once
could silently overwrite each other. One writer avoids the race outright — and that writer is you.

If no subagent tool is available, fall back to reading the documents one at a time in this
session — `ingest next`, without `--all`, still gives you the single next document exactly as
before.

**A question can only cite a claim that is already in the ledger, and a subagent cannot see the
ledger.** Its isolated context is one document, nothing else — it has no way to know another
document's claim ids, or even that another document said something conflicting. That is what
`conflicts` is *for*: a subagent flags only what it can actually see, a contradiction inside its
own document, by position. Spotting a contradiction *between* documents is the coordinator's job,
not a subagent's — by the time you have recorded two documents' claims you have both their real
ids, which is exactly what a subagent dispatched to either one alone never has.

**b. Collect — one result at a time, never batched.** For each subagent's result, **in order, one
Bash call at a time — do not issue these as parallel tool calls**, and mark it read only once every
`record` call below has succeeded — a failed `record` must never be followed by `read`, or the
document reads as done with something not recorded for it:

1. Write the subagent's returned JSON to `<scratch>/claims-<doc>.json` — its final message is the
   content of that file, not a command to run. One file; `record` and `enrich` below each read only
   the keys they know and ignore the rest, so it is never split in two.
2. Record its claims:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" ingest record @<scratch>/claims-<doc>.json
```

3. If the subagent's JSON named any `conflicts`, `record`'s own output just told you the real id
   each of that batch's claims got, in the order you submitted them — map each `conflicts[].about`
   position to its real id, and record the question citing them in a second `record` call, before
   moving on.
4. Record its enrichment from the same file, if the subagent returned any — `summary`, `keywords`
   and `headings` are all optional, so skip this call for a document that came back with none:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" ingest enrich <path> @<scratch>/claims-<doc>.json
```

5. Only now, with every claim, question and enrichment for this document recorded:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" ingest read <path>
```

Same commands as before either way, just looped over a batch's results instead of run once.
Recording stays serial even though the reading happened in parallel: that is the whole reason the
unlocked ledger stays safe to leave unlocked.

**c. Record contradictions as questions, sparingly.** When the code contradicts a document, that is
not a question — the code wins, so record the true claim and note the stale document. Raise a
question only when evidence genuinely cannot settle it — the first of these is yours to notice as
you collect, not a subagent's:

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
*before* it ever moves to arbitration — and if there is nothing to arbitrate either, `next` skips
straight to emit. Reading is only actually finished once `next` itself reports the arbitrate or
emit phase, not just because the pending list emptied.

## 3. Classify relevance

Once every document is read, decide what each one still is — using the claims and the enrichment
already recorded, corpus-wide, not per-document: spotting an overlap needs to see more than one
document at once, which is exactly what a subagent isolated to a single document never could (§2).

Four classifications, and nothing else:

- **`keep`** — current, relevant, unique.
- **`merge`** — relevant, but overlaps one or more other documents. Name the strongest overlap as
  `mergeTarget`.
- **`archive`** — outdated, but worth keeping for history (a deprecated feature's own docs, say).
- **`delete`** — no value: empty, an abandoned draft, superseded with nothing left worth keeping.

Every verdict needs a `justification`, the same way a question needs its `because` — a classification
with no reasoning behind it is exactly the guess-in-the-voice-of-a-fact this ledger refuses
everywhere else. Write the batch and record it in one call:

```json
[
  { "path": "docs/old-setup.md", "classification": "delete", "justification": "..." },
  { "path": "docs/api.md", "classification": "merge", "justification": "...", "mergeTarget": "docs/reference.md" }
]
```

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" reorg classify @<scratch>/verdicts.json
```

A verdict is asserted, not arbitrated — the same standing a claim has, not a question's. It is not
put to the user for approval one at a time; it is recorded, and `dev.mjs reorg` reports the counts.
Re-classifying a document (a rescan changed it, or the reasoning improves) simply replaces its
verdict — nothing to undo first.

## 4. Find what says the same thing — and what disagrees

Classification looked at each document on its own. This step looks at them two at a time, and
only where the enrichment says it is worth looking:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" reorg shortlist
```

It ranks every pair of `keep`/`merge` documents by how much their recorded keywords overlap and
prints the ones at or above a threshold (`--similarity-threshold`, default 0.85), with the keywords
they share. **Judge only the shortlisted pairs, never every pair** — that is the whole point of the
shortlist: a corpus of sixty documents has 1,770 pairs, and reading both sides of each of them is
the pass no session survives. If the list is empty, lower the threshold once to see the nearest
pairs; if it is still empty, there is nothing to compare and this step is done. It also says how
many documents it could not compare — unclassified, or without keywords — which is work for §3 or
§2, not a reason to guess.

**a. Judge each shortlisted pair yourself, here.** Open both documents, and decide which of three
things they are:

- **`duplicate`** — the same content, near enough word for word.
- **`overlaps`** — the same subject, some of the same ground, each with something the other lacks.
- **`contradicts`** — they disagree about a fact or a reason.

A pair carries **evidence from each side** — `evidenceA` and `evidenceB`, an anchor or a quote — and
a `justification`, and the tool refuses one without them, for the reason it refuses an unanchored
claim. Record the batch in one call:

```json
[
  { "docA": "docs/setup.md", "docB": "docs/install.md", "relation": "duplicate",
    "justification": "the same twelve steps in the same order",
    "evidenceA": "docs/setup.md:8-31", "evidenceB": "docs/install.md:5-28" }
]
```

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" reorg detect @<scratch>/pairs.json
```

A pair is asserted, like a verdict, not arbitrated: recorded, and re-judging the same two documents
replaces the earlier call under the same id. Its output lists the id each pair got.

**b. Raise an inconsistency sparingly.** A `contradicts` pair is usually settled by the code — one
side is stale, the code says which, and the claims in the ledger already record that. Raise an
**inconsistency** only where evidence genuinely cannot settle which document is right: two intents
that disagree, or a contradiction the code is silent on. It cites the pairs behind it in `because`,
and the tool refuses one that cites nothing — same discipline as a question. Record it in the same
call as its pairs, or in a later one once you know their ids:

```json
{
  "pairs": [ ... ],
  "inconsistencies": [
    { "text": "setup.md says the cache is advisory, design.md says it is the source of truth — which holds?",
      "because": ["p3"], "options": ["advisory", "source of truth"] }
  ]
}
```

**c. Put the open inconsistencies to the user, at most five at a time**, exactly as §5 puts
questions — each with the pairs and evidence behind it and the options you can see. A resolution is
typed, because the mapping step that comes after this has to act on it:

- **`prefer:<path>`** — that document is authoritative; it must be a side of a cited pair.
- **`rewrite`** — both are partly right; the merge is where they get reconciled.
- **`dismiss`** — they do not actually disagree.

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" reorg resolve i3 prefer:docs/design.md "design.md is what the team maintains; setup.md predates the cache"
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" reorg resolve @<scratch>/resolutions.json   # [{ "id", "kind", "path"?, "note" }]
```

A resolution is permanent, like an answer: record what they actually said, and if they do not know,
**leave it open**. Nothing maps over an open inconsistency — `dev.mjs reorg` says which ones block
it — and that gate is deliberate: a mapping that runs over an unsettled contradiction picks a side
silently, which is the one thing this whole process exists to avoid.

## 5. Arbitration

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

## 6. Emit

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" ingest emit
```

Writes `_dev-workflow/artifacts/documentation/map.md`: claims grouped by topic, each with its
anchor, plus the decisions and anything still unsettled. It is generated — regenerate it, never
edit it.

## 7. Map onto the target set, and write the staged tree

**This skill never rewrites the project's documentation.** Not one line. Everything it writes lives
under `_dev-workflow/artifacts/` — the survey under `documentation/`, and from here on the draft
under `reorg/`. The draft is the deliverable; applying it is not this skill's job.

**a. The target set comes from the user, as a file.** Ask for it, or draft one and show it: which
documents the project should end up with, each with an `id` (it names the file, `<id>.md`), a
`title` and a `description` of what belongs in it. JSON, or YAML of exactly this shape — a flat
`sections:` list, nothing nested, no block scalars; the parser refuses anything else by line rather
than guessing:

```yaml
sections:
  - id: architecture
    title: Architecture
    description: how the system is built and why
  - id: operations
    title: Operations
    description: how it is run, deployed and observed
```

Where the project has `docs.set` configured, the eight keys of `lib/docset.mjs` are the natural
sections; the file is still the user's to write, because the target set is a decision, not an
inference.

**b. Map each current document onto it.** Using the verdicts (§3), the pairs and resolutions (§4)
and the recorded headings, write one entry per heading of the new tree — which sources, or which
headings of them, become it, and how:

- **`copy`** — one whole document becomes this section.
- **`split`** — named headings of one document become it; the rest goes elsewhere.
- **`merge`** — two or more documents (or headings of them) become one section, in order.
- **`rewrite`** — you write the new text yourself, in `text`, from the sources you name.

A `merge` verdict names its target, a `prefer` resolution names which side survives a
contradiction, a `rewrite` resolution is exactly the `rewrite` operation with both sides as sources.
A source's `headings` are matched verbatim against what §2 recorded — `## Storage`, marker
included, not `Storage`. Archived and deleted documents cannot be sources; the tool refuses them,
and lists them in the plan instead. Every entry carries a `justification`, the same standing as everything else recorded here.

```json
[
  { "section": "architecture", "heading": "Storage", "operation": "merge",
    "sources": [{ "path": "docs/design.md", "headings": ["## Storage"] }, { "path": "README.md" }],
    "justification": "design.md is authoritative (i2 prefer); README's paragraph adds the pool size" },
  { "section": "operations", "heading": "Install", "operation": "copy",
    "sources": [{ "path": "docs/setup.md" }], "justification": "the only setup document; keep verdict" }
]
```

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" reorg map --architecture <arch.yaml> @<scratch>/mapping.json
```

It refuses while an inconsistency is open — that is the gate §4 described, and
`--ignore-inconsistencies` is the override, printed and recorded in the plan so nobody mistakes it
for a settled tree. It writes `_dev-workflow/artifacts/reorg/migration-plan.md`: the entries per
target, **the current documents no entry names**, and the archive/delete list. Show the plan to the
user, and fix the mapping until the "Not mapped" section says what they mean it to say — a
document left out by accident and one left out on purpose look identical in the output.

**c. Write the draft.**

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" reorg rewrite --dry-run
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" reorg rewrite
```

If `map` needed `--ignore-inconsistencies`, `rewrite` needs it too: it checks the ledger again, so an
inconsistency raised since the plan was made still blocks the tree. One file per target under
`_dev-workflow/artifacts/reorg/docs-reorganized/`, assembled from the real source text — a whole document, or the heading ranges named — plus `migration-report.md`
saying what was written from what, what was not mapped, and what is listed as archive or delete.
**Listed, never deleted:** this tool removes nothing, ever. A file in the staged tree that somebody
edited by hand is refused on the next run rather than overwritten, and says so; `--force` is the
user's call.

**d. Then it is ordinary work.** The staged tree is a draft for review, not the project's docs.
Applying it — copying a file into `docs/`, deleting a superseded one, archiving another — is a
change to the project like any other: `/dev-task` it, so it goes through a ticket, a branch and a
review. Do not start moving their files because the draft made it obvious what to do.

## Stopping and resuming

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" ingest        # where it stands
```

Stop whenever. The ledger holds the sources, the claims, the questions and answers, the
classification verdicts, the pairs with their resolutions, and the mapping, and it is committed with
the rest of `_dev-workflow/`, so a colleague picking it up gets every decision too — not just the
map. `dev.mjs reorg` says where classification, detection, the gate and the mapping stand.

Two things worth saying out loud when you report progress: how many documents are left, and how many
claims turned out to contradict the code. The second number is the finding.
