# Contributing

`CLAUDE.md` at the repo root is the architecture document — the three surfaces and their
constraints, the provider contract, the git invariants, and what the installer is allowed to write
in someone else's project. Read it before changing anything under `lib/`, `scripts/` or `bin/`.

This file covers the one thing that cannot be automated: verifying a change that writes.

## Checks

```bash
npm test        # lint + unit tests + hook table test
npm run lint    # bash -n, node --check, shellcheck when installed
```

`npm test` covers the hook's exit codes across 30 message shapes, the config merge, the YouTrack
brace rule, the install manifest and drift detection, and the reconciler's forward-only and
off-ladder rules.

Note that `shellcheck` is **skipped when it is not installed**, and prints `lint: clean` anyway. CI
installs it, so CI is stricter than a bare local run. If you touch a shell script, get shellcheck on
your PATH first.

## Verifying a write path

The read paths (`dev.mjs fetch`, `create --dup-check`, `dev.mjs config`, a `dev.mjs sync` dry run)
can be exercised freely against any instance. The **write paths cannot be verified without writing
once**, and a dry run that looks perfect proves nothing about them — `dev.mjs sync --apply` once
shipped with a command the API rejects, and every dry run had reported the correct plan.

So: after changing anything that writes, run it once against a real issue.

- `dev.mjs create` on a throwaway issue you then close.
- `dev.mjs update` or `dev.mjs sync --apply` on a ticket that genuinely needs moving.

Then re-run it, and confirm the operation is idempotent.

**Never swallow stderr from a write.** The first `--apply` failure printed only `update failed`,
which is worthless — the parser error underneath named the problem exactly.

## Commits

Conventional commits, with the issue reference in the subject: `feat(api): add the thing (#123)`.
Work with no issue behind it uses the `<type>(no-ticket):` escape hatch — the scope carries the
meaning, so any configured type can wear it, and ticketless work is not forced to be a
non-releasing `chore`.

Two things enforce this and they split the job: `hooks/check-commit-ticket.sh` is a `PreToolUse`
hook that owns the *issue reference* and only sees `git commit -m` issued through the agent; husky's
`commit-msg` hook runs commitlint, which owns the conventional-commit *shape* and catches editor
commits, `-F` files and amends.

## Releasing

`semantic-release` cuts the release automatically on every push to `main`, gated on both CI jobs
passing. There is no manual version bump.

The consequence is that **the commit type is a release decision, not a label**: `feat` cuts a minor,
`fix` a patch, `!` a major, and everything else ships nothing. The full pre-push checklist is the
repo-local `/release` skill in `.claude/skills/`.
