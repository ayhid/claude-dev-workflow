# 0002. Retire the CI-posted adversarial reviewer; keep the lenses local

- Status: accepted
- Date: 2026-08-30

## Context

`.github/workflows/adversarial-review.yml` posted the three-lens review to every pull request
automatically, via a Mistral chat completion per lens. Measured against real diffs rather than
argued about: a 17-line calibration probe with a planted defect found it with all three lenses and
landed 5 of 7 findings. A live run against a 628-line diff landed only 2 of 8, and both of those
were documentation nits. Six of the eight claims were false, three of them contradicting each other
about the same guard — one calling it too strict, another too loose — and every one of the six
passed evidence verification, because the model quoted the code correctly and reasoned about it
wrongly. Confabulation scaled with diff size; mistral-small could not reason reliably about a guard
it could quote verbatim. The constraint this forced: an automated reviewer that is right on a
17-line diff and wrong on a 628-line one cannot be trusted unattended on a pull request of arbitrary
size, because the failure mode is not "returns nothing" — it is "returns confident, contradictory,
evidence-backed-looking claims."

## Options considered

- **Keep the CI reviewer as it was** — rejected on the measurement above. Posting six false claims
  (three of them mutually contradictory) to a real pull request costs more of a reader's trust than
  the two real nits it found were worth, and the failure mode does not announce itself: every claim
  passed the evidence-quote check, so nothing in the pipeline would have flagged the run as bad.
- **Use a larger model** (`mistral-large-latest`) — tried, not chosen. It returns `403
  tier_not_allowed` on this account's plan (commit `3233837`), so it is not available regardless of
  whether it would have reasoned better at 628 lines. Upgrading the plan to test this was not
  pursued once the CodeRabbit alternative below made the CI reviewer's value marginal either way.
- **More prompt tuning** — rejected. The tuning already done (`e896e80`, `add7d29`, `afac1f9`,
  `08a556d`) fixed real, measured defects in the lens contract and evidence pipeline, and every one
  of those fixes is kept — the lens files are not reverted, only unhooked from CI. But the specific
  failure this decision is about (630-line-scale confabulation) was diagnosed from one sample. Prompt
  tuning against one sample fits that sample; it does not establish that the next 628-line diff would
  fare any better, and there is no cheap way to get a second sample without repeating the exposure
  this decision exists to stop.
- **Retire the CI reviewer, keep the lens definitions, run them only through local `/dev-review`
  (chosen)** — a person reads the output before anything is claimed on a pull request, which is
  the one property none of the above alternatives can add back. CodeRabbit already reviews every
  pull request on this repo, so retiring the CI reviewer trades one automated pass for a different
  one that already runs, rather than for nothing. The lens text is the product of the tuning work
  above and is not discarded — `/dev-review` runs all three lenses unchanged, so an eventual larger
  or more capable model could be pointed at the exact same contract without redoing this work.

## Consequences

Posting to a pull request now requires a person to run `/dev-review` and read the result before
anything from these lenses reaches a PR comment — nothing posts unattended. `lib/review.mjs`, which
shipped into every consumer project as the rendering contract for the CI action, needed a new
caller inside the payload once the action was deleted; it is now reached through
`dev.mjs review --render`, which is a permanent addition to the installed command surface, not a
transitional one.

This forecloses automated review on pull requests from this repo's own tooling until a model is
available that can be re-measured against the same 628-line-scale test and shown not to
confabulate — re-adding the CI action without repeating that measurement would be the exact mistake
this decision was made to stop repeating. It also means a PR that nobody runs `/dev-review` against
gets no adversarial pass from this stack at all; CodeRabbit is the only automated backstop left, and
its coverage and failure modes are not the ones measured here.
