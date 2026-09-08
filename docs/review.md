# The review findings contract

`/dev-review` runs three lenses over one branch — blind, edge, audit — and each returns its findings
as JSON. `dev.mjs review --render` turns the three results into one comment. The shape of that JSON,
what the renderer does with it, and what it refuses, is defined once, in `lib/review.mjs`, and this
page is the account of it.

It is exercised **locally only**. The CI action that used to post the same report to every pull
request was measured and retired ([ADR 0002](decisions/0002-retire-the-ci-posted-adversarial-reviewer.md)):
confabulation scaled with diff size faster than the findings did, so a person now reads the output
before anything reaches a PR. The contract survived that decision unchanged — the lens definitions
are the product of the tuning work the ADR records, and a more capable model can be pointed at the
same shape without redoing it.

- [What a lens returns](#what-a-lens-returns)
- [The fields](#the-fields)
- [What `normalizeFindings` repairs, and what it drops](#what-normalizefindings-repairs-and-what-it-drops)
- [Evidence: three states, not two](#evidence-three-states-not-two)
- [Merging: one entry per line, never per file](#merging-one-entry-per-line-never-per-file)
- [Two halves of one report](#two-halves-of-one-report)
- [Changing the contract](#changing-the-contract)

## What a lens returns

An object with a `findings` array. Two more arrays may sit beside it, and neither is a finding:

```json
{
  "findings": [ { "...": "one object per defect, fields below" } ],
  "questions": [ "what the lens could not work out from the diff alone" ],
  "axesChecked": [ "inputs walked and found already handled" ]
}
```

`questions` is where the blind lens puts what it was *supposed* to be unable to explain — its
condition, not a discovery. `axesChecked` (`axes_checked` is accepted) is how a lens shows its
coverage was real without producing a finding to prove it: a long list beside an empty `findings`
is good work, not a lazy review. A bare array is also accepted as `findings`, since a model asked
for JSON will sometimes skip the wrapper.

The skill collects the three results into one file and hands it to the renderer:

```bash
dev.mjs review --render findings.json --payloads <the dir dev.mjs review wrote>
```

```json
{ "model": "the model that ran the lenses",
  "meta":  { "files": 6, "lines": 493 },
  "lenses": [ { "name": "blind", "findings": [], "questions": [] },
              { "name": "edge",  "findings": [], "axesChecked": [] },
              { "name": "audit", "findings": [] } ] }
```

A lens entry carrying `error` or `skipped` instead of `findings` is reported under *Lenses that did
not report*, and a review in which **no** lens reported says so in its first line. "No findings
across 0 lenses" is the sentence a reader skims and takes for a pass.

## The fields

Each finding, after `normalizeFindings`:

| Field | Required | What it is |
| --- | --- | --- |
| `title` | **yes** | The headline. A finding without one is dropped and counted — a location alone renders as a checkbox with nothing after it. Falls back to `problem`, then `summary`. |
| `file` | no | The path the finding is anchored to. Falls back to `path`; absent, it is `(unattributed)`, which is not a path and never a merge key. |
| `line` | no | A **positive integer**, or `null`. Falls back to `lineNumber`. `1.5`, `0`, `"abc"` all become `null` — a line no file has is not an anchor. |
| `severity` | no | One of `blocker`, `major`, `minor`, `nit`, worst first. Anything else becomes **`minor`**. |
| `bucket` | no | One of `intent-gap`, `bad-spec`, `scope-creep`, `patch`, `deferred`. Anything else is **omitted** — there is no fallback. |
| `evidence` | no | A verbatim quote of the code being accused. Checked by `verifyEvidence`, never trusted. |
| `problem`, `consequence`, `fix` | no | Free text, printed when present. |
| `trigger`, `behavior`, `test` | no | Lens-specific: the edge lens's exact input, what happens on it, and a runnable test. Printed when present, never invented. |

Every string is trimmed; a non-string is treated as absent. The renderer adds `lens` (the name it
was given under) and `id`, a short deterministic hash of lens, file, line and title, so a re-run of
an unchanged branch produces the same ids and a reader can tell a repeat finding from a new one.

The audit lens's verdict on a criterion is a finding like any other: `file` set to the code that
should have satisfied the criterion and `title` naming it. There is no separate verdict field.

### Why `severity` falls back and `bucket` does not

They are different kinds of guess. A wrong severity costs a reader one heading — the finding is
still in the list, under *Minor* instead of *Major*, and the prose beneath it says what it is.
A wrong bucket sends the fix to the wrong place: `intent-gap` means fix the code, `bad-spec` means
fix the spec first, and fixing code to a bad spec encodes the mistake. Guessing a triage category
is worse than leaving it for a person to sort, so an invalid bucket is left out of the machine
JSON entirely rather than printed as `""`, which an agent could read as a sixth, valid category.

Both fallbacks are stated in a doc comment on the line that applies them, in `lib/review.mjs`, so
this page and the code are one grep apart.

## What `normalizeFindings` repairs, and what it drops

A model asked for JSON will occasionally return a field as a number, omit one, or wrap the array
in another key. None of that is worth failing a review over, so the shape is repaired where it can
be:

- a numeric `line` in a string is coerced; a string `severity` with stray whitespace is trimmed;
- `problem` or `summary` stands in for a missing `title`, `path` for `file`, `lineNumber` for `line`;
- a non-object entry in the array is dropped and counted.

It **drops** exactly one thing on purpose: a finding with no title, by any of its spellings. The
count of dropped findings is returned beside the list and printed on stderr by `--render`, so a
lens that produced ten and had three thrown away says so rather than reporting seven.

## Evidence: three states, not two

`verifyEvidence` is the one check a model cannot talk its way past. It exists because of a real
run: a lens reported five boundary failures against one numeric guard, four of which that guard
already handled. Describing code is easy to get wrong; reproducing it is not. A finding whose quote
is absent from the payload has not been shown to be about this diff at all.

The check is per lens, against the payload **that lens was given** — the blind lens's quotes are
matched against `change.diff` only, never against the `intent.md` it was not shown. Matching is
whitespace-insensitive and tolerates unified-diff `+`/`-` prefixes between joined lines, so a quote
survives re-indentation and a model quoting two consecutive added lines verbatim.

Every finding comes out in one of three states, and the report keeps them apart:

| `verified` | Meaning | Where it lands |
| --- | --- | --- |
| `true` | the quote was found in the lens's payload | the main list |
| `false` | the quote was looked for and **not found** | held back under a separate heading, with the reason — segregated, never deleted, because a reformatted quote lands here too |
| `null` | **never checked**: no `--payloads` given, no quote supplied, or one shorter than 12 characters (`}` matches every file and proves nothing) | the main list, marked *Not verified* with the reason in `unchecked` |

`false` is an accusation: the lens described code it imagined. `null` is not. A blocker whose author
omitted the quote is a blocker nobody has checked, and filing it under "quoted code that is not in
this diff" says something about it that is not true while hiding it. Collapsing these two states
back into one re-introduces exactly that defect.

A report rendered without `--payloads` says so in its second line — **Evidence was not checked** —
because a checked report and an unchecked one were once byte-identical, and a reader had no way to
tell a verified quote from a lens's unsupported claim.

## Merging: one entry per line, never per file

Three lenses reaching one defect is the strongest signal in a review, and printing it three times
is the fastest way to make a 17-line diff look like it has seven problems. `mergeFindings` collapses
findings that share the same **`file:line`** — and the same verification state, since a verified
quote and an unverified one are two different claims about the same code — into one entry with
one checkbox.

What it deliberately does *not* do is decide which of them are the same defect. Comparing titles
and fixes does not work: "MAX_PER_GROUP silently drops findings" and "off-by-one in MAX_PER_GROUP
slice" are the same defect and share three tokens out of seventeen. So the only claim made is the
one the data supports: these findings are about the same line.

Two rules follow from that:

- **Never on `file` alone.** An unanchored finding — no line, or `(unattributed)` as its file —
  always keeps its own entry. Two `(unattributed)` findings that happen to share a line number are
  not about the same code, and merging them would manufacture the one signal the report tells its
  reader to trust most.
- **Worst severity wins, and the prose comes from the same finding.** The entry is led by the
  worst-severity item, so one lens calling it a nit never downgrades another calling it a blocker,
  and the title and fix shown under *Blockers* are the blocker's own, not a wordier nit's.

Every other lens's title and fix are kept beneath the entry under `alsoSaid`, as
`<lens>: <title> — <fix>`, so a second lens's concrete remediation for the same line reaches the
reader. `alsoRaisedBy` lists the other lenses by name, and a finding reached independently sorts
above an uncorroborated one of the same severity — the report's own advice is to start there.

## Two halves of one report

The comment is a checkbox list a person works through, over a JSON block an agent reads. Both are
derived from the same validated findings, so nothing is stated twice and the two cannot disagree —
which is a property the code has to keep, not one it gets for free. A field rendered in the prose
and silently dropped from the JSON is the exact defect two `/dev-review` runs on this repository's
own history found and fixed.

The JSON half prints, per finding: `id`, `lens`, `file`, `line`, `severity`, `title`; `bucket`
only when valid; `lenses` only when more than one; and `alsoSaid`, `evidence`, `verified: false`,
`unchecked`, `problem`, `consequence`, `fix`, `trigger`, `behavior`, `test`, `alsoRaisedBy` each
only when present. `verified: true` is the default and is not printed.

## Changing the contract

The five criteria below are the bar for the next change to `lib/review.mjs`, recorded in
[#70](https://github.com/ayhid/claude-dev-workflow/issues/70) after the contract stabilised across
#67, #69 and #68. They are what the audit lens checks a change against; a change that meets them
is one the lens can pass, and one that does not is one it should fail.

- [ ] A new **required** field is rejected by `normalizeFindings` when a lens omits it, with a
      `dropped` count — never silently defaulted into something that looks valid.
- [ ] A new **fallback** value (like `severity`'s `minor`) is documented in the same doc comment as
      the field it defaults, so drift between the two is one grep away from being caught.
- [ ] `verifyEvidence`'s three states — verified, not verified, never checked — are preserved.
      Collapsing any two of them back into one re-introduces the "unquoted blocker looks invented"
      defect fixed in PR #69.
- [ ] The prose (checkbox) and JSON halves of `renderReport` stay in agreement. A field rendered in
      one and silently dropped from the other is the defect described above.
- [ ] `npm test` covers the new behaviour with a test that **fails when the change is reverted** —
      mutation-checked, not just present.
