# claude-youtrack-workflow

A Claude Code plugin for ticket-driven development against YouTrack. This file is for working
**on** the plugin; `README.md` documents using it.

## Three surfaces, three sets of constraints

| Surface | Runs | Constraint |
|---|---|---|
| `bin/install.mjs`, `bin/lib/*` | once, at install | Node ≥18. May use dependencies freely. |
| `scripts/*` | on every skill invocation | Node. Deps must survive both install paths (see below). |
| `hooks/check-commit-ticket.sh` | **on every Bash tool call** | Bash + jq only. Latency-critical — keep the fast-bail first. |

The hook stays bash on purpose: `PreToolUse` with `matcher: "Bash"` fires on every command, so its
non-commit exit path must cost ~3ms, not a ~50ms Node boot.

## Distribution: two paths, and neither runs `npm install`

- `npx github:ayhid/claude-youtrack-workflow` — npm installs deps.
- `/plugin marketplace add` — **Claude Code clones the repo and never runs `npm install`.**
  Verified: an installed plugin at `~/.claude/plugins/cache/<market>/<plugin>/<version>/` has no
  `node_modules`, and an upgrade lands in a *new* version-scoped directory, empty again.

Anything under `scripts/` must therefore resolve its dependencies itself. That is what
`scripts/bootstrap.mjs` is for — keep `scripts/yt.mjs` dependency-free at its top level so it can
report a missing dependency instead of dying with `ERR_MODULE_NOT_FOUND`.

`main` is the distribution channel for both paths. A broken commit ships immediately.

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

- `skills/`, `hooks/`, `scripts/`, `.claude-plugin/` — **shipped** to users.
- `.claude/`, `tests/`, `.github/` — repo-local development only. Never rely on these at runtime.
- Enforcement belongs in `hooks/`; repeatable procedure belongs in a skill; only always-true
  conventions belong in this file.

## Checks

```bash
npm test        # lint + unit tests + hook table test
npm run lint    # bash -n, node --check, shellcheck when installed
```

Commits in this repo use the `chore(no-ticket):` escape hatch — the plugin is installed at user
scope, so its own commit hook applies here, and this repo has no YouTrack project of its own.
