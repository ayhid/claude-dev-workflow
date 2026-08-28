# Decision records

`/dev-adr` and `dev.mjs adr` keep a project's architecture decision records: what was decided,
which alternatives were rejected, and why.

## Why the format is what it is

An ADR is not a description of the system. `architecture.md` says what the shape *is*; a decision
record says **which alternatives were rejected and on what grounds**.

Two templates are in common use. Nygard's original (Context / Decision / Status / Consequences) is
five sections and no ceremony. MADR adds an explicit *Considered Options* section with the case
against each one. What ships here is MADR trimmed to three sections, because that one section is
the whole reason the format beats a commit message — and unforced, it does not get written.

```markdown
# 0007. Worktrees by default

- Status: accepted
- Date: 2026-08-28
- Deciders: ayoub

## Context

What forced a decision. The constraint, not the history.

## Options considered

- **Branch switching** — disturbs uncommitted work in the main checkout.
- **Worktrees** **(chosen)** — starting a ticket never touches work in progress.

## Consequences

What this makes easy, what it makes expensive, what it forecloses.
```

## Commands

| Command | What it does |
| --- | --- |
| `dev.mjs adr new "<title>"` | Scaffolds the next record as `proposed` — editable |
| `dev.mjs adr accept <N>` | Freezes it. From here the hook refuses edits |
| `dev.mjs adr reject <N>` | Argued and turned down. The record stays |
| `dev.mjs adr supersede <N> "<title>"` | New record; links written in both directions |
| `dev.mjs adr list` | Every record and its status |
| `dev.mjs adr index` | Regenerates the index (every write already does) |

`--dir PATH` overrides the configured directory for one run.

## The two-step is the design

`new` scaffolds a **proposed** record, `accept` freezes it. That is not ceremony — it is what lets
the guard exist at all. A record is editable while you are still filling in the options with it;
`accept` is the moment it becomes history. Without two steps the hook would have to choose between
blocking the author mid-sentence and never blocking anything.

## Rules the tooling enforces

1. **A number is never reused.** It is a permanent address, cited from code and from other
   records. `adr new` counts from the highest number ever seen, not from the file count, so
   deleting `0003` does not hand `0003` to the next record and silently reparent every citation.
2. **An accepted record is never edited — it is superseded**, and the link is written in *both*
   directions. `hooks/check-adr-immutable.sh` blocks the edit and names the supersede command.
3. **The index is generated.** Every write regenerates it. Hand edits are overwritten.

### The gap in rule 2, stated plainly

The hook matches `Edit|Write`, not `Bash`. That keeps it off the every-Bash-call latency path the
commit hook is built around, but **an ADR rewritten through `sed -i` or a shell heredoc is not
seen**. Closing that would mean a Bash arm and the latency cost that comes with one. It is a
deliberate trade, not an oversight.

## Configuration

```jsonc
{
  "docs": {
    "decisionsDir": "docs/decisions",  // relative to the project root
    "enforce": true                    // false disables the immutability hook
  }
}
```

`decisionsDir` has a default rather than being required, unlike `github.labels`. The distinction is
what a wrong value costs: a wrong label mapping fails *silently* — the ticket never moves — while a
wrong directory is visible in the first `adr new`'s output, which names the path it wrote to.

A monorepo wanting records per package points this at a package directory, or runs with `--dir`.

## Citing a record from code

At the choke point the decision constrains, leave the number:

```js
// see docs/decisions/0007 — worktrees, not branch switching
```

The place a reader needs the reasoning is the code, not the docs directory. One line, at the one
place the constraint bites.

## Reading them in Obsidian

Obsidian is a lens over a folder of markdown; it takes custody of nothing. The files stay in git,
readable on GitHub and by any other tool. That makes it a cheap thing to try and a cheap thing to
abandon — nothing here depends on it, and the workflow **never writes `.obsidian/`**. This is a
recipe you apply by hand, not an install step.

**Turn wikilinks off.** Settings → Files & Links → uncheck *Use `[[Wikilinks]]`*, and set *New link
format* to *Relative path to file*. You lose nothing: backlinks, graph view, autocomplete and
unresolved-link detection all work on ordinary `[text](0007-worktrees.md)` links. What you gain is
records that still render as links on GitHub and in a PR diff, where `[[0007]]` shows up as literal
brackets.

**Scope the vault to the docs directory**, not the repo root — or add `node_modules` to *Excluded
files*. Plenty of packages ship markdown and the graph fills with noise otherwise.

**Gitignore `.obsidian/`** for solo work. If you want shared vault config, commit `app.json` and
`core-plugins.json` only; `workspace.json` churns on every pane you move.

Two plugins earn their place:

- **Templater** — bind a hotkey to the ADR template so a new record is one keystroke. This attacks
  the real problem, which is capturing the decision at the moment it is made rather than a week
  later.
- **Dataview** — a live query of records by status, so "what is still `proposed`" needs no
  maintenance.

A Dataview block renders as a code fence on GitHub, so it cannot replace the generated index. Use
it for your own navigation and let `adr index` keep the committed one. Two readers, two indexes,
one source of truth.

### Across several projects

Keep committed records self-contained: **a link inside a repo's records must never point outside
that repo**, or it breaks for everyone who clones just that one. If you want the cross-project
graph, put a personal umbrella vault above your projects and let *its own* notes carry the
cross-repo links. The repo stays correct for other readers; the connections stay yours.
