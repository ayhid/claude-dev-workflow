---
name: dev-review
description: Review the current branch through three adversarial lenses — a blind pass that never sees the intent, an edge-case pass, and an acceptance audit — and report findings sorted into fix-the-code, fix-the-spec and out-of-scope. Use before opening a PR, when asked to review a branch, or when the user types /dev-review.
argument-hint: "[blind | edge | audit | all] [--base REF]"
---

# /dev-review — three lenses over the same diff

`$ARGUMENTS` selects the lenses: `blind`, `edge`, `audit`, or empty for all three.
A trailing `--base REF` is passed through to the payload command.

## What makes this different from reading the diff

One reviewer reading a diff once finds what that reviewer is disposed to find. The three lenses
here are not three styles of thoroughness, they are three **different payloads**, and the payload
is what produces the finding:

| Lens | Sees | Finds what the others cannot |
|---|---|---|
| blind | the diff, nothing else | the gap between what the code says it does and what it does |
| edge | diff + full source of the changed files | the input that breaks it |
| audit | diff + source + the ticket | code that does not match the intent, **and intent that is wrong** |

The lens text lives in `lenses/blind.md`, `lenses/edge.md` and `lenses/audit.md` next to this
file. Read the one you are running and follow it as written — it is the same file the CI review
runs on, so a finding here and a finding on the PR come from identical instructions.

## 0. Load the project's workflow config

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" config
```

If it reports `MISSING`, run `/dev-init` first and stop.

## 1. Build the payloads

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" review
```

One command, one turn. It prints the branch, the base it diffed against, the file and line counts,
and the paths of the three payload files. It writes files rather than printing the diff on purpose:
a diff pasted into this session is paid for again on every later turn, and the blind lens must not
be able to see this session at all.

**Two answers mean stop rather than review:**

- *Nothing reviewable changed.* There is no diff. Say so; do not review the branch from memory.
- *Past the 800-line ceiling.* Report the number and offer to split the branch. A model asked to
  review 2,000 lines does not review them more shallowly, it starts inventing findings, and a
  fabricated finding costs more of the user's trust than a missed one.

## 2. Run the lenses

### blind — in a fresh subagent, always

**This lens cannot run in this session.** Its entire premise is that the reviewer has not been told
what the change is for; you have just read the ticket, or written the code. You cannot un-know it,
and a lens that is blind in name only produces confirmation dressed as review.

So dispatch it to a **fresh subagent** whose whole context is the lens plus the diff:

- system/instructions: the contents of `lenses/blind.md`, verbatim
- input: the contents of `change.diff`, and **nothing else** — no ticket, no PR description, no
  summary of what you were trying to do, no file paths beyond what the patch itself carries

If no subagent tool is available, **say the blind lens was skipped and why**. Do not run it here
and call it blind.

### edge — in this session

Read `lenses/edge.md` and apply it to `change.diff` plus `context.txt`. The full source matters
here: an edge case is only real if the surrounding code fails to handle it, and the patch alone
does not show the guard three lines above the hunk.

### audit — in this session

Read `lenses/audit.md` and apply it to all three payloads. `intent.md` is the ticket, fetched by
the payload command from the tracker.

If `intent.md` reports that no issue ID was in the branch name, that is **pass 1's first finding**,
not a reason to skip the lens: work with no recorded why is the most expensive thing this lens
looks for.

## 3. Report

Each lens returns JSON — an object with a `findings` array, fields as its lens file
specifies. Do not paraphrase them into prose: the same shape is what the CI review posts, and an
agent picking the work up reads the fields rather than the sentences.

**Check every `evidence` quote against the payload before you report the finding.** The quote is
verbatim code the lens claims to be accusing; if those characters are not in `change.diff` or
`context.txt`, the lens is describing code it imagined rather than read. This is not a formality —
the first live run of these lenses reported five boundary failures against one numeric guard, and
that guard already handled four of them. Hold an unverified finding back under a separate heading,
say why, and do not delete it: a reformatted quote lands there too.

Two arrays are not findings and must never be counted as them:

- `questions` — what a lens could not work out from the diff alone. The blind lens is *supposed*
  to be unable to explain why something changed; that is its condition, not a discovery. Report
  these separately, and never as defects.
- `axesChecked` — inputs walked and found already handled. This is how a lens shows its coverage
  was real without having to produce a finding to prove it. A long `axesChecked` beside an empty
  `findings` is good work, not a lazy review.

Write the three lenses' JSON to one file and let the command render it:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" review --render findings.json --payloads <the dir from §1>
```

```json
{ "lenses": [ { "name": "blind", "findings": [...], "questions": [...] },
              { "name": "edge",  "findings": [...], "axesChecked": [...] },
              { "name": "audit", "findings": [...] } ] }
```

Do not write the markdown yourself. The command owns the format — severity order, the checkbox
line, the JSON block an agent reads — so a report from this skill and a report from anywhere else
are the same bytes, and `--payloads` re-checks every `evidence` quote against the payload **its own
lens** saw. Findings quoting code that is not there are held back automatically rather than printed
as fact, which is a check you cannot perform reliably by eye.

A lens that failed gets `{"name": "edge", "error": "..."}` instead of findings. Say what happened;
never quietly render two lenses as though three ran.

Two readings that only exist once the lenses are put together, and they are the reason for running
more than one:

- A finding **two lenses reach independently** — same file, same line — is almost always real.
  Mark it and put it first.
- A finding raised **only by the blind lens** that the intent already covers is usually a
  readability problem rather than a defect: the code works and fails to say so. Report it as such
  rather than as a bug.

Sort every finding into exactly one bucket. This is what makes the report actionable rather than a
wall of text:

- **intent-gap** — the code is wrong. Fix the code.
- **bad-spec** — the code faithfully implements a wrong spec. Fix the spec first, or the fix
  encodes the same mistake.
- **patch** — a real local defect. Fix it now.
- **scope-creep** — correct, but nobody agreed to maintain it.
- **deferred** — legitimate but out of scope. Offer to file it with `/dev-bug`.

**A lens that failed is named, never dropped.** "Two lenses ran, the edge lens returned nothing
usable" is an honest report; silently printing two lenses' findings as though three ran is not.

## 4. Do not fix, and do not land

This skill reports. It does not edit files, and it never moves the ticket.

Offer the fixes as a list and let the user choose. `/dev-done` is what verifies acceptance
criteria and lands the work; a review that quietly rewrote the branch would leave the user
reviewing your changes instead of their own.
