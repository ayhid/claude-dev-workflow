# 0005. A naming rule for skills, commands and agents

- Status: accepted
- Date: 2026-09-09

## Context

The installed surface is 15 `dev-*` skills, 23 `dev.mjs` subcommands and 5 agents. Every name was
chosen inside the ticket that added it, against no rule, so the only thing holding the set together is
whoever last happened to notice a neighbour. Four kinds of drift followed, and one of them is
destructive rather than merely confusing.

**`update` names two unrelated acts, one letter from a third spelling of one of them.**
`dev.mjs update <ID>` writes the tracker. `dw update` refreshes the project's payload. So does
`dev.mjs version --upgrade` — a write hidden behind a flag on a command whose name says *report*.
`scripts/dev.mjs` carries the reason in a comment: "Not `upgrade`: one letter from `update` above,
which writes to the tracker." That comment is the decision this record replaces. The collision was
found, understood, and then routed around by overloading a third command, because there was no rule
saying a name that writes may not sit one letter from a name that reports.

**One act has a different name on each layer.** `/dev-file` drafts and files an issue by running
`dev.mjs create`. A user reads the skill and the command together; they disagree about what the act is.

**Parts of speech and word order are unrelated to meaning.** Skills are mostly imperative verbs —
`plan`, `split`, `build`, `review` — but `task`, `bug`, `standup` and `adr` are nouns and `done` is an
adjective. `/dev-docs-init` and `/dev-ingest-docs` name one subject in opposite orders, three
characters apart in the same directory listing. `/dev-lint-rules` reads as "lint the rules" when the
skill produces them. `reorg` is the only truncation in a set of whole words.

**Four words name one concept.** `issue`, `ticket`, `task` and `bug` all name the thing work is filed
against — `<ISSUE-ID>` in argv, "ticket" throughout `CLAUDE.md`, "task" in the entry point's name.

Two constraints bound any answer. Skills live in **one flat namespace** shared with every other tool
the user has installed, which is already why `CLAUDE.md` refuses to claim `task`, `bug` or `done`
unprefixed — so a skill name has to be distinctive against strangers, not just against its siblings.
And renaming is **cheap in the installer and expensive in prose**: `bin/lib/payload.mjs`'s delete pass
removes an owned, unplanned, non-generated path unconditionally, without consulting whether the user
edited it, so an old skill directory disappears on the next `--update` with no alias needed — while the
names themselves appear in roughly 200 places across `README.md`, `docs/`, `CLAUDE.md`, `bin/`,
`tests/` and the skills' own cross-references.

## Options considered

- **Leave the names alone and fix each one as it bites.** Rejected — this is the option that produced
  the set. The `update`/`upgrade` collision is the proof: it bit, it was diagnosed precisely, and the
  response was a comment plus a workaround on a third command. Case-by-case repair cannot fix a
  problem whose symptom is that nothing is comparable to anything.
- **One vocabulary: a skill and its subcommand always share a word, everywhere.** Rejected — it reads
  as consistency but forces invention. `config`, `rules`, `status` and `version` report a subject and
  have no skill at all; making them verbs would name acts they do not perform, and giving them skills
  would add four entry points nobody asked for. The layers have different jobs: a skill is an act a
  user asks for, a subcommand is what the machine does. They should agree *when they are the same
  act*, which is a narrower and checkable claim.
- **Name skills for the artifact or the phase — nouns throughout — rather than the act.** Rejected —
  a noun cannot separate `/dev-file`, `/dev-plan`, `/dev-split` and `/dev-build`, which all concern one
  issue. The act is the only thing that differs between them, so it is the only thing a name can carry.
- **Keep every old skill name as a deprecated alias for one major.** Rejected — an alias and its
  target both match `dev-*` in a flat namespace, so the model may load either, and a name that
  sometimes resolves elsewhere is worse than one that is gone. The installer already makes the clean
  path available: the delete pass removes the old directory on the next update, so the alias would buy
  nothing but ambiguity.
- **A rule, stated per layer, with its exceptions named rather than left to taste.** Chosen. Below.

## Decision

- **R1** — A **skill** is named for the **act the user is asking for**, as an imperative verb. Not the
  artifact, not the phase, not the thing the act is about.
- **R2** — A **CLI subcommand** is named for the act, as a verb, with two licensed noun positions: when
  it groups sub-verbs it takes its **subject** (`adr new|accept`, `docs init|render`), and when it
  purely **reports** one subject (`config`, `rules`, `status`, `version`).
- **R3** — **One act, one word**, across both layers and both binaries. A skill and the subcommand it
  drives share the word when they are the same act.
- **R4** — Two names may not differ by only a prefix, a suffix or one letter **when one writes and the
  other reports**. Confusion whose cost is destructive must be spelled far apart.
- **R5** — A compound name is `<verb>-<subject>`, never `<subject>-<verb>`.
- **R6** — Whole words, excepting a name the industry itself writes short: `adr`, `tdd`, `standup`,
  `docs`.
- **R7** — An **agent** is named for its **role**, as a noun (`dev-reader`, `dev-builder`) or a
  subject-lens (`dev-review-blind`). An agent is dispatched; it is not an act a user asks for, so R1
  does not reach it. Recorded so the existing agent names are not later mistaken for drift.

Two carve-outs, argued rather than assumed:

- **`/dev-bug` keeps its noun.** A skill that files exactly one *configured issue type* takes that
  type's name, and `bug` is a value in the project's `.dev-workflow.json` rather than a word we chose.
  Renaming it would put our vocabulary in front of the user's own configuration.
- **`dev.mjs assess` keeps its object-free verb.** Its object is the only one it could take — the
  project — so naming it would be padding, not clarity.

Two names in the first application were **arbitrated, not derived**, and the rule does not settle them:

- **`/dev-work`, over keeping `/dev-task` as a licensed noun.** R1 says "named for the act", and a
  router's whole job is determining which act applies — so R1 has no single answer here. Applying it
  won over carving it out, but the argument for the carve-out was real.
- **`/dev-write-rules`, over `/dev-enforce` or the status quo.** `enforce` overstates a skill that
  proposes rules and counts what each would flag; the old name misreads as "lint the rules".

## Consequences

**What this makes easy.** A proposed name is now checkable against something, by a reviewer or by the
author, before it ships. The destructive collision goes: R4 forces the tracker write and the payload
refresh apart, which turns `version --upgrade` back into a plain reporter and gives the payload refresh
one name across both binaries. And R2's licensed noun-group turns out to describe what
`update <ID> state|comment|raw` already was — a subject with sub-verbs, the same shape as `adr` and
`docs` — so the fix is an application of the rule rather than an exception to it.

**What it costs, stated so a later reader knows it was priced.** Four skills are renamed —
`/dev-task`→`/dev-work`, `/dev-done`→`/dev-finish`, `/dev-docs-init`→`/dev-init-docs`,
`/dev-lint-rules`→`/dev-write-rules` — and skill names are the surface users type, so this is a
breaking change and cuts a major. `/dev-task` and `/dev-done` are the two most-referenced names in the
repo. The renames reach roughly 200 references, and every one is prose or a test path rather than
behaviour, which makes the change wide, dull, and easy to leave half-done: the verification that
matters is a grep proving no old name survives and a real double install proving the old directories
are gone.

**What it forecloses.** Truncations, so no future `reorg`. And, for now, **`hooks/*` filenames**:
`mergeHookIntoSettings` only ever adds an entry to `.claude/settings.json` and never prunes a
superseded one, while the delete pass removes the script unconditionally — so renaming a hook would
delete the file and leave its command string pointing at a missing path, firing on every Bash tool call
in every consumer project. `check-commit-ticket.sh` therefore keeps the word this rule otherwise
retires, until the merge learns to prune. That is a defect in its own right, not a naming question, and
it is filed as one.

The rule binds new names from here. It is not a licence to reopen the two carve-outs above each time
someone reads it: they were argued once, and the arguments are in this record.
