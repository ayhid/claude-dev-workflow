# The documentation set

`/dev-docs-init` and `dev.mjs docs` give a **greenfield** project the documents it does not have
yet — context, architecture, domain, api, ux, operations, testing, security — and fill them a claim
at a time.

`/dev-ingest-docs` is the other half, for a project that already has documentation: it reads what is
there into a verified map. The two share a ledger, a validator and a renderer on purpose. **Ingest
turns documents into claims; `docs` turns claims into documents.**

- [Why a claim and not a document](#why-a-claim-and-not-a-document)
- [The set](#the-set)
- [The commands](#the-commands)
- [What it refuses](#what-it-refuses)
- [Two documents that already exist](#two-documents-that-already-exist)

## Why a claim and not a document

"Read the repo and write the docs" produces prose nobody can falsify. Six months later no one can
tell which sentences are still true, so the whole artifact rots at the speed of its worst line — and
a session that trusts it confidently reimplements something that already exists.

So nothing here writes prose. You record **claims**, and `docs render` turns them into markdown:

| Field | What it is |
| --- | --- |
| `text` | one statement, not a paragraph |
| `kind` | `observable` or `intent` |
| `anchor` | `file:line`, or the command that shows it. **Required for `observable`.** |
| `source` | who asserted it. **Required for `intent`** |
| `target` | which document it belongs in |
| `topic` | the heading it sits under |

`renderDocument` takes claims and emits bullets. There is no parameter a paragraph could be passed
through, so an unfalsifiable sentence is not discouraged — it is **unrepresentable**.

`/dev-adr`'s renderer *does* take free prose, and that is not an inconsistency. An ADR is dated,
immutable and never claims to describe the present, so it cannot rot the way `architecture.md` rots.
A document asserting how the system is *now* must carry, per sentence, the thing that would show it
false.

### On a young project, most claims are `intent`

A two-week-old codebase yields a handful of anchored `observable` claims and a lot of attributed
`intent` ones — "sessions are in memory because the service is single-instance for now (ayoub)".

**That is the correct output, not a degraded one.** Six months later a reader can tell which
sentences were ever checkable and which were one person's belief on a Tuesday. A skeleton padded out
with confident prose to look finished loses exactly that distinction.

## The set

Defined once, in `lib/docset.mjs`, and configured with [`docs.dir` and
`docs.set`](configuration.md#docs--the-documentation-set-and-decision-records).

| key | file | holds |
| --- | --- | --- |
| `context` | `docs/context.md` | why this exists, who it is for, what it deliberately does not do |
| `architecture` | `docs/architecture.md` | components, boundaries, data flow |
| `domain` | `docs/domain.md` | the glossary — terms, and what they mean *here* |
| `api` | `docs/api.md` | the external contract: what callers may depend on, and what may change |
| `ux` | `docs/ux.md` | the user-facing surface: flows, screens, states, and their rules |
| `operations` | `docs/operations.md` | the runbook: run it, deploy it, what breaks |
| `testing` | `docs/testing.md` | what is tested, how to run it, what deliberately is not |
| `security` | `docs/security-model.md` | trust boundaries, secrets, what is assumed |
| `decisions` | `docs.decisionsDir` | a **pointer** — `docs init` writes nothing, it prints `/dev-adr` |

`decisions` is a pointer because numbering and freezing records is `/dev-adr`'s job, and a second
writer for them would be a second copy of that rule. It is in the set anyway so the set is complete:
a skeleton that silently omits decisions reads as though a project needs none.

The security document is `security-model.md` for a specific reason, [written down in the
configuration reference](configuration.md#why-the-security-document-is-security-modelmd) rather than
quietly tolerated.

### Why `api` is separate from `architecture`

They rot at different speeds. An internal boundary moves when somebody refactors; an external
contract moves when somebody breaks a consumer. One document carrying both is re-rendered on every
refactor, so a reader cannot tell from its history whether anything they depend on changed.

### Why `context` and `ux` will mostly hold `intent` claims

A goal is somebody's stated intent — there is no line of code that would show "this is for
self-hosting teams" false — so claims there carry an attributed source rather than an anchor. That is
[correct rather than degraded](#on-a-young-project-most-claims-are-intent).
`api` is the opposite: a contract is anchorable to the file that declares it, so an `observable`
claim there with no anchor is a real error.

## The commands

```bash
dev.mjs docs                        # which documents exist, and what backs each one
dev.mjs docs init [--only KEY,...]  # scaffold the missing ones; idempotent
dev.mjs docs record @claims.json    # add claims, each naming its target
dev.mjs docs render [KEY]           # re-render from the ledger
dev.mjs docs check                  # exit 1 if one drifted or is still a stub
```

Claims are JSON, and a batch with one bad claim in it is refused whole — a half-recorded batch can
never be mistaken for a complete one:

```json
{
  "claims": [
    { "text": "The HTTP entry point is src/server.ts", "kind": "observable",
      "anchor": "src/server.ts:12", "target": "architecture", "topic": "shape" },
    { "text": "Sessions are in memory because the service is single-instance for now",
      "kind": "intent", "source": "ayoub", "target": "architecture", "topic": "storage" }
  ]
}
```

The ledger is the one `/dev-ingest-docs` writes,
`_dev-workflow/artifacts/documentation/ledger.json`. Two ledgers would be two answers to "what does
this project claim about itself".

### `docs check` in CI

`check` exits non-zero three ways: a document that does not exist, one still holding the stub marker
`docs init` wrote, and one that no longer matches what the ledger renders. Once the documents are
real it is worth running in CI — it is the thing that notices a claim was recorded and never folded
in.

A missing document is reported as one of two different facts, because they call for different
commands. A document the ledger has never registered as generated has **never been scaffolded** —
nobody has been asked about it, which is what an updated project sees for a document the set gained
— and the fix is `docs init`. One the ledger *did* generate and that is now gone has claims and a
sha256 behind it, so the fix is `docs render <key>`; `docs init` would rewrite it as a stub and lose
them. The exit code is 1 either way: the document is still missing.

It cannot fail spuriously with time. Nothing in a rendered document comes from the clock: dates are
the `recordedAt` the ledger already holds, so the same ledger renders the same bytes a year later.

## What it refuses

| Refusal | Why |
| --- | --- |
| `docs init` on a `brownfield` project | There is documentation to read; that is `/dev-ingest-docs`. |
| `docs init` with no `stage` set | A wrong stage sends this down the wrong branch and nothing downstream would notice. Proposed by `dev.mjs assess`, settled by a person. |
| An `observable` claim with no anchor | An unanchored claim is a guess in the voice of a fact. |
| An anchor naming a file not in the repo | The commonest failure of a model writing about a codebase is an invented filename. Shared with `ingest record`, so the two cannot disagree about what an anchor is. |
| A claim with no `target`, or one outside `docs.set` | Every mapping comes from config; a guess that is usually right is worse than an error. |
| Overwriting a document `docs init` did not write | A hand-written `docs/architecture.md` is somebody's work. |
| Re-rendering over a hand-edit | The ledger has never seen that prose. `dev.mjs ingest scan` is what absorbs it. |

Line numbers in anchors are **not** re-verified. `/dev-ingest-docs` deferred mechanical anchor
re-verification deliberately and this does not reopen it: a line that drifted by three still points
a reader at the right file.

## Two documents that already exist

A generated document is registered in the ledger with the sha256 that was written to it. That does
two jobs.

It keeps `dev.mjs ingest scan` from offering our own output back for extraction — a generated
`docs/architecture.md` is still a `.md` under `docs/`, and reading it back in would compound every
mistake it ever made.

And it is what tells a file this tool wrote from one somebody edited. Edit a generated document by
hand and its hash stops matching: `docs render` refuses to overwrite it, `docs check` names it as
hand-edited, and the next `ingest scan` puts it back in the extraction queue with its claims marked
stale. The edit survives until it has been absorbed as claims, which is the only way round that does
not lose somebody's prose.

Documents live in the project's own `docs/`, outside `_dev-workflow/`. That is deliberate and is not
a hole in the installer's boundary: `isOwnedPath` binds the **installer**, which must never decide on
its own to write somewhere it does not own. This is a runtime command acting on an explicit request,
the way `adr new` and `note` already do.
