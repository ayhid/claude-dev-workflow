# claude-youtrack-workflow

Ticket-driven development against YouTrack, installed **per project** as Claude Code skills. This
file is for working **on** it; `README.md` documents using it.

## Three surfaces, three sets of constraints

| Surface | Runs | Constraint |
|---|---|---|
| `bin/*` | once, at install, from the npx checkout | Node ≥22. May use dependencies freely. |
| `lib/*`, `scripts/*` | on every skill invocation, from the installed copy | **Zero dependencies** — node: builtins only. |
| `hooks/check-commit-ticket.sh` | **on every Bash tool call** | Bash + jq only. Latency-critical — keep the fast-bail first. |

The zero-dependency rule for `lib/` and `scripts/` is load-bearing, not an aesthetic: the payload
is copied into the user's project as plain source with no `node_modules`, so it has to work in a
Python or Rust repo. Anything you `import` there must come from `node:`.

The hook stays bash on purpose: `PreToolUse` with `matcher: "Bash"` fires on every command, so its
non-commit exit path must cost ~3ms, not a ~50ms Node boot.

## Distribution: one path

`npx github:ayhid/claude-youtrack-workflow` copies `lib/`, `scripts/` and `hooks/` into the
project's `_youtrack/`, the skills into `.claude/skills/yt-*`, and merges the commit hook into
`.claude/settings.json`. Nothing is installed globally; there is no plugin manifest.

`bin/lib/payload.mjs` owns that, and records a sha256 per file in
`_youtrack/_config/manifest.json`. That manifest is what makes a re-run an *update*: unchanged
files are replaced, files the user edited are reported and left alone, files no longer shipped are
removed. Never overwrite a user's edit silently, and never overwrite `.claude/settings.json`
wholesale — merge into it, since users have their own hooks there.

`main` is the distribution channel. A broken commit ships immediately.

## YouTrack API invariants — learned the hard way, do not regress

1. **The commands API returns 200 for commands it did not apply.** Always read the state back and
   report what you actually found. The exit code proves nothing.
2. **Only values containing a space may be braced.** Braces mark where a multi-word value ends;
   they are not quoting. `State {In Review}` is correct, `State {Staging}` is rejected outright,
   and `Type {Bug} Priority {X}` parses as the single value `{Bug} Priority` and 400s.
3. **A dry run proves nothing about a write path.** `yt-sync --apply` once shipped with a command
   the API rejected while every dry run reported the correct plan. Exercise writes for real.
4. **Never swallow stderr from a write.** The first `--apply` failure printed only `update failed`;
   the parser error underneath named the problem exactly.

## Security properties to preserve

- The token is never written to disk and never appears in `argv`. Pass it in a `fetch` header;
  shell out with `execFile`-style argument arrays, never an interpolated shell string.
- `.youtrack.json` holds no secret — `tokenOpRef` is a 1Password *reference* — and is meant to be
  committed by consumers.

## Layout

- `lib/`, `scripts/`, `hooks/`, `skills/` — **copied into user projects.** Adding a file here
  ships it; `bin/lib/payload.mjs` picks these up wholesale, so nothing repo-specific may live in
  them.
- `bin/` — the installer. Runs from the npx checkout only, never from a user's project.
- `.claude/`, `tests/`, `.github/` — repo-local development only. Never referenced at runtime.
- Enforcement belongs in `hooks/`; repeatable procedure belongs in a skill; only always-true
  conventions belong in this file.

Skill names are namespaced `yt-*`. They live in a flat namespace next to every other skill the
user has installed, and `task` / `bug` / `done` are far too generic to claim.

## What we own in a user's project, and nothing else

A project is shared ground — other skill-based tools install their own payload directories and
their own skills alongside ours. We write to exactly two roots:

- `_youtrack/**`
- `.claude/skills/yt-*/**`

`isOwnedPath` in `bin/lib/payload.mjs` is that boundary, and **every write and every delete goes
through it** — including the removal pass, so a hand-edited or corrupted manifest still cannot
reach a file that is not ours. A planned write outside those roots is a hard error, not a warning.

`.claude/settings.json` is the one genuinely shared file. It is **merged, never rewritten**: the
user's own hooks survive, and our entry is matched by command string so a re-run does not
duplicate it.

Depend on nothing from any other tool, and assume nothing about its layout. Interoperation here
means staying out of the way, not integrating.

## Checks

```bash
npm test        # lint + unit tests + hook table test
npm run lint    # bash -n, node --check, shellcheck when installed
```

Commits in this repo use the `chore(no-ticket):` escape hatch: this repo has no YouTrack project
of its own, and `.claude/settings.json` registers `hooks/check-commit-ticket.sh` against the
source tree, so the guard we ship applies to us too. That registration is the only thing making it
apply — dogfooding here is deliberate, and removing the entry silently removes the enforcement.
