# 0001. A PreToolUse hook enforces ADR immutability

- Status: accepted
- Date: 2026-08-28
- Deciders: ayoub

## Context

An accepted decision record must not be edited — it records what was known at a moment, and
editing it rewrites that moment while every citation of its number carries on pointing at the file.
That rule is worthless unless something enforces it, because the moment it is inconvenient is
exactly the moment it will be broken, and nothing else in the repository will notice.

This repository already splits enforcement two ways: `hooks/` holds what must be blocked as it
happens, and commands hold what a person or CI chooses to run. The question was which side this
rule falls on. The constraint that makes it a real question is latency — `hooks/check-commit-ticket.sh`
fires on every Bash call and is built around a ~3ms bail for that reason.

## Options considered

- **`dev.mjs adr check`, a command run by the skill and by CI** — zero cost on the hot path, works
  in a project with no CI wired up at all. Rejected because nothing forces it to run: a consumer
  project that never wires it up gets the rule as advice, and a rule nothing applies is the same
  as no rule. This is the same reasoning that put the git refusals in one `git()` wrapper rather
  than at call sites.
- **A hook plus the command** — most thorough. Rejected as more surface than the problem has yet
  earned: two enforcement paths to keep in step, and no evidence yet that either is insufficient.
- **A `PreToolUse` hook** **(chosen)** — it blocks the edit at the moment it is attempted, which is
  the only point at which the author can still be told why. Made affordable by matching `Edit|Write`
  rather than `Bash`: file writes are rare compared to shell calls, so the guard can afford to read
  the target file, and it never runs on the commit hook's hot path.

## Consequences

Makes the rule real rather than documented: an accepted record cannot be edited through the tools
the agent normally uses, and the refusal names `adr supersede` so the correct path is one command
away.

Costs a known gap. Because the matcher is `Edit|Write` and not `Bash`, an ADR rewritten through
`sed -i` or a shell heredoc is not seen. Closing it would mean a Bash arm and the latency budget
that comes with it, which is a price to pay once the gap has actually been hit rather than in
anticipation. The gap is written into `docs/decisions.md` so it is a known limit rather than a
surprise.

Also establishes that a second shipped hook is registered through one list — `SHIPPED_HOOKS` in
`bin/lib/payload.mjs` — rather than a second copy of the settings merge. A third hook is now one
entry rather than a new opportunity to forget the merge.
