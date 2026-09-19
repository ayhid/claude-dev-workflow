# 0007. Done is a proof the author checks, from the session he works in

- Status: accepted
- Date: 2026-09-18
- Deciders: Ayoub Hidri
- Supersedes: [0006](0006-done-is-a-proof-the-author.md)

## Context

Three weeks of instrumented use, and the author cannot name one occasion on which this tool preserved
intent for him. The transition log says why, exactly:

```
Done transitions:                                   53
  closed by CI reconciliation, human never asked:   50
  closed by a local command the author ran:          3
  ...of those 3, --criteria answered:                0
Merged PRs (20):     13 with zero reviews.  Sep 8 alone: 8 PRs, ~13,000 lines.
Open review queue:   8,417 lines, 81 files, oldest waiting 7 days.
Written since Aug 28: 43,203 insertions against 4,569 deletions.
```

`lib/metrics.mjs` names `criteria` the one field the code cannot observe — *"whether the acceptance
criteria passed first time, and it is null when nobody said."* Nobody has ever said. Under
`delivery.mode: pr` nobody is ever asked: CI merges, `sync --deep` observes the close, the row is
written with `criteria: null`, and the ticket leaves the board without passing in front of anyone.
`/dev-done` — which demands evidence per criterion and refuses to close on an unmet one — ran for 3
of 53 tickets. The other 50 skipped it structurally, not by negligence.

The intent loss is upstream of that. The author states a sentence; `/dev-file` and `/dev-plan` expand
it into a spec; `/dev-tdd` builds against that spec; `dev-review-audit` audits against it; `/dev-done`
closes against it. #162 carries ten acceptance criteria the author did not write. **Every gate grades
the expansion. Nothing at any point compares the result to the sentence.** The loop is closed and the
person who wanted the thing is outside it.

Nothing reports what was built, either. `scripts/cmd/land.mjs:102` composes the pull request body as
the issue body plus `Closes <ID>` — so a PR hands back the spec it was given, restated. There is no
slot anywhere in the pipeline for *what now happens differently*, and no slot for how to see it.

Two further symptoms, same cause. The author was unaware that three competing plan documents
(`AUDIT.md`, `IMPLEMENTATION_PLAN.md`, `docs/workflow-improvement-plan.md`, 1,087 uncommitted lines)
had accumulated, one declaring authority over another — the continuity artifacts are written and not
read. And the command names (`/dev-file`, `/dev-plan`, `/dev-split`, `/dev-build`) name the system's
acts, not the author's, which is why ADR 0005's rule produced a set he still does not recognise.

**And the author cannot run any of it.** `dw` — the installed binary — exposes `init`, `update`,
`version` and `help`: the installer, and nothing else. The twenty-two lifecycle commands are reachable
only as `node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" <cmd>`, a spelling written for a
hook rather than a hand. Asked to freeze the record this one replaces with `dev.mjs adr accept 6`, the
author's answer was that he can never launch commands of that kind. So the tool has exactly one
operator, and it is the agent. That is why the ADRs cannot be found, why the standup reads as noise —
it only ever arrives unbidden at session start, never on demand — and why every close happened
somewhere the author was not.

**Record 0006 got the diagnosis right and the surface wrong.** Its fifth rule put the fix in a shell:
`dw standup`, typed at a terminal. The author does not work at a terminal; he works in a Claude
session, and a command he must leave that session to run is a command he will not run. The existing
`/dev-*` skills do not close the gap either — they are *procedures*. Typing `/dev-adr` opens an
interview about recording a decision; it does not accept record 6 and print the result. What is
missing is a passthrough: a slash command that runs a subcommand, prints its output, and stops.

## Options considered

- **Cap the size of a reviewable unit** — a line ceiling refused at split time. Rejected: it makes
  unreviewable work smaller, not more trustworthy. 31% of the current queue is the committed
  `_dev-workflow/` mirror of code already in the same diff; shrinking the number would not have told
  the author whether any of it answered what he asked for.
- **Stop pretending review happens** — drop the gate, deliver direct, let the suite judge. Rejected:
  honest about the 13 unreviewed merges, but it deletes the last human judgement instead of restoring
  it, and tests grade the generated spec too.
- **A criterion-to-evidence table on every PR** — each criterion paired with the test that makes it
  true. Rejected as the primary proof: it verifies the expansion, which is the loop the author is
  already outside. Kept as supporting material, below the fold.
- **A recorded demo transcript in the PR body** — pasted by the agent that wrote the code. Rejected
  as sufficient: evidence produced by the author of the change is not independent, and it becomes one
  more thing to not read.
- **Freeze the tool and go use it** — plausible, and reconsidered every time the backlog grows. Not
  chosen now because it answers the symptom (too much tool) and not the cause (no proof at the end).
- **The proof runs in a shell, through `dw`** — record 0006's rule 5, superseded here. Rejected: it
  is a surface the author does not use, so it produces rules only the agent can follow, which is the
  condition being ended.
- **A generated slash command per subcommand** — `/dw-standup`, `/dw-land`, one file each, derived
  from the CLI's own list so the names cannot drift. Rejected despite its discoverability: it needs a
  fourth owned install root, and it puts the vocabulary in a second place, which ADR 0005 exists to
  prevent.
- **One `/dw` passthrough, plus a proof the author checks** — chosen.

## Decision

**A ticket is not done until its author has checked its proof. The proof is declared at planning
time, in the author's words, it is checkable in about a minute without reading code, and it is
invoked from the session the author is already in.**

Five rules follow, and they bind commands rather than prose:

1. **Every ticket carries a proof, written before any code exists.** For behaviour, one command and
   what you should see when you run it. For vocabulary, the list of names to read and recognise. A
   ticket whose proof nobody can state is not planned yet, and `/dev-plan` says so instead of
   proceeding.
2. **`land` composes the pull request body, and the spec is not the top of it.** Three lines of *what
   now happens differently* — behaviour, not implementation — then *see it yourself* with the command,
   then everything else below the fold. The three-line cap is enforced in `land`, not requested in
   prose: #160 shows what an uncapped explanation becomes, 51 lines ending in a rename of a local
   variable.
3. **Nothing closes without the author.** `--criteria` stops being optional on a local close, and an
   observed close is recorded as `Merged`, never `Done`, until the proof is checked. A close the
   author did not witness is not a close; it is a merge with a label on it.
4. **A mechanism that adds reading is a regression, whatever else it does.** Applied to what already
   exists as well as to what is proposed: an artifact nobody reads gets deleted, not improved.
5. **`/dw` is how the author reaches the tool.** One skill, a passthrough: `/dw <subcommand> [args]`
   runs `_dev-workflow/scripts/dev.mjs` with exactly those arguments, prints the output, and stops —
   no interview, no interpretation, no plan. `/dw help` lists every verb, which is how a vocabulary
   stays discoverable without being written down twice. It is the cheapest thing the tool does, one
   turn and no reasoning, and it is built first: rules 1 and 3 are unimplementable while the author
   cannot invoke a command at all.

## Consequences

`/dw` is the first work item and the smallest: one skill file that forwards its arguments, with
`disable-model-invocation` set so nothing but the author's own typing triggers it. Its proof is
itself — type `/dw standup` and the report appears. Until it exists, every rule above describes a
workflow only the agent can operate, which is the condition this record was written to end.

The author becomes the gate on every ticket — roughly sixty seconds each — and nothing reaches Done
while he is away. That is the trade being accepted deliberately: throughput to date assumed he would
never be asked, and 53 tickets closed without a single one of them asking.

The fleet epic (#145, #148, #149, #150) does not survive this unchanged. It builds three tickets at a
time, refilled until the board empties — a machine for producing closes nobody witnesses. It is
either re-scoped to fill a queue of proofs the author works through one at a time, or dropped.

The five naming tickets (#137, #138, #139, #141, #142) survive, and they are the reason rule 1 says
*proof* rather than *demo*. Running a rename shows nothing; reading the resulting set of names and
recognising one's own act is a check of the same cost and the same falsifiability. A rule admitting
only demos would have refused the only work in the backlog that addresses the author's own
comprehension.

`_dev-workflow/` being committed beside its source doubles every diff this repo produces. Under rule
4 it is a reading cost with no reader: its correctness is a CI question — run the installer, assert
the tree is unchanged — not a review question.

A skill named `dw` sits outside the `dev-*` namespace this repo reserves, deliberately: it is the
product's own name, it is the one name the author has to remember, and prefixing it would make the
thing he types longer than the thing it runs. ADR 0005's rule that one act gets one word across every
layer is what makes the passthrough legal — `/dw adr accept 7` and `dev.mjs adr accept 7` are the same
words in the same order, which is only true because the subcommand names are not restated anywhere.

This record reorders ADR 0004: the lifecycle it split stays split, and each step now owes a proof at
the end rather than a state change.
