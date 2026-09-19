# 0008. Stop installing the workflow into its own repository

- Status: accepted
- Date: 2026-09-19

## Context

From the beginning this repository was one of its own consumers. The installer's output was
committed here — `_dev-workflow/` (57 files), `.claude/skills/dev-*` (18), `.claude/agents/dev-*.md`
(5), `.dev-workflow.json` — and the copy was not decoration: `.claude/settings.json` registered
`_dev-workflow/hooks/check-commit-ticket.sh` rather than the source-tree one, both `SessionStart`
hooks ran from the payload, and `.github/workflows/reconcile.yml` executed
`node _dev-workflow/scripts/dev.mjs sync --apply --deep` on every merge. The argument was that the
path a user actually gets is the path enforced here.

It bought three things. A daily proof that the copied tree runs with no `node_modules`. A working
board for this repo's own tickets. And enforcement — the commit guard and the ADR immutability guard
of ADR 0001 — applied to the tool's own development.

It cost more than it looked. 83 committed files that are generated, not written, so every branch
that touched `lib/`, `scripts/` or `hooks/` carried a second copy of its own diff and re-conflicted
on the manifest at every rebase. A drift gate, `tools/check-payload.mjs`, whose whole reason to
exist was keeping that copy in step. A CI job with a hard dependency on the payload. And a standing
invitation to edit the copy instead of the source, which the manifest then protects as a user edit —
silently preserving a change that is not in what ships.

The decisive change is external to the code: the tool is now exercised directly on real projects,
where it is installed the way a user installs it. Self-installation stopped being the verification
and became the thing that most needed maintaining.

## Options considered

- **Keep the self-install** — rejected. Its strongest claim, "the copy is what runs here", is now
  false in the place that matters: what runs is whatever is installed in the real projects being
  worked in. Keeping it means paying the merge conflicts and the drift gate to dogfood a path that
  is already being dogfooded better elsewhere.
- **Keep the committed copy as a fixture, stop using it** — rejected. A payload nothing runs is a
  payload nobody notices going stale, and the only signal it was stale would be the very check that
  exists to compare it. It keeps all of the cost (conflicts, the invitation to edit the copy) and
  discards the one benefit that justified them.
- **Remove it and prove the install against a scratch directory** — accepted. The CI `install` job
  already installs into `/tmp/scratch` and asserts the tree runs, the hook enforces, and a re-run is
  idempotent. `checkPayload` already takes `sourceRoot` and `projectDir` separately, so pointing it
  at a fresh install is the same comparison against a tree nobody can hand-edit between runs.
- **Remove it and drop the byte-identity check entirely** — rejected. The unit tests assert the
  installer's *plan*; only a comparison after a real write proves the copy is verbatim and that the
  delete pass leaves no orphan behind.

## Decision

This repository is source-only. `_dev-workflow/`, `.claude/skills/dev-*`, `.claude/agents/dev-*.md`,
`.dev-workflow.json` and `.github/workflows/reconcile.yml` are deleted, and the four hooks the
payload registered in `.claude/settings.json` are unregistered.

The drift gate becomes an install gate. `npm run check:payload` installs into a temporary directory
and compares it against the sources `planFiles` names; CI runs the same comparison against the
scratch install the `install` job already performs. What is being asserted changes with it: not
"the committed copy is still in step with the source next door", which no longer has a subject, but
"an install writes the planned files verbatim and leaves nothing behind".

Nothing that ships changes. `package.json#files` lists none of the deleted paths.

## Consequences

The ADR immutability guard of ADR 0001 no longer runs here. It remains the product's behaviour and
is still tested by `tests/adr-hook.test.sh`; in this repository an accepted record is now protected
by review alone. The same holds for the commit guard: `commitlint` still enforces the conventional
shape through Husky, but nothing enforces the `(#123)` reference, which becomes a convention.

This repo's GitHub issues are no longer reconciled by the tool. A ticket closes when a merged PR
says `Closes #N`, or by hand.

Sessions opened here get no standup and no update notice, which is the second half of the same
trade: the greeting spent context on a board this repo no longer keeps.

The branches in flight when this landed each carried their own payload copy and conflicted with the
deletion once, resolved by taking it.

The `/release` skill's real install into `/tmp/rel` and the CI `install` job are now the only proof
the copied tree runs. They were always the better proof; they are now the whole of it, so a change
that weakens either one has nothing behind it.
