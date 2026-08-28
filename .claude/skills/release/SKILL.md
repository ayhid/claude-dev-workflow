---
name: release
description: Pre-push checklist for the dev-workflow installer — verify the write paths and a real install before pushing to main, then watch the automated release land. Use when asked to release, cut a version, or ship.
argument-hint: ""
---

# Release

Repo-local: this skill is development tooling for this repository and is **not** shipped to users.

**You do not choose or bump the version.** `semantic-release` does that on every push to `main`,
deriving it from the commit types since the last tag, writing it back to `package.json`, tagging,
publishing to npm and cutting a GitHub Release. `release.config.mjs` and the `release` job in
`.github/workflows/ci.yml` own that.

What this skill covers is everything the automation *cannot* check. The release job is gated on CI
(`needs: [test, install]`), so nothing ships over a red tree — but CI has no tracker instance and no
token, so **no write path is ever exercised there**. Pushing to `main` publishes. Verify first.

## 1. Check the commit types actually say what you mean

```bash
git log $(git describe --tags --abbrev=0)..HEAD --oneline
```

The type is the release decision: `feat` → minor, `fix` → patch, `!` → major, anything else ships
nothing. Two failure modes, both silent:

- a `chore(no-ticket):` that was really a feature — **no release happens at all**, and the fix is to
  amend the type before pushing, not to force a version;
- a `feat:` that was really a tidy-up — a minor version goes out for nothing.

The escape hatch takes any type (`feat(no-ticket):`, `fix(no-ticket)!:`) precisely so ticketless work
can still be released. Use it.

## 2. Run the checks

```bash
npm test
```

Lint, unit tests and the hook table test. All must pass. Do not proceed on a failure, and do not
summarise a failure away — report the output.

## 3. Verify the write paths for real

**A dry run proves nothing about a write path.** `dev.mjs sync --apply` once shipped with a command
the API rejected while every dry run had reported the correct plan. The read paths (`config`,
`fetch`, `create --dup-check`, a `sync` dry run) can be exercised freely; the writes cannot be
verified without writing.

So, against a real instance, if anything touching a write path changed:

```bash
node scripts/dev.mjs create "Release smoke test" "ignore me" Task Minor   # prints the new ID
node scripts/dev.mjs update <ID> "State In Progress"                      # check the read-back line
node scripts/dev.mjs update <ID> comment "smoke"
node scripts/dev.mjs sync --apply                                          # if there is real drift
```

Then **re-run each one** to confirm it is idempotent, and close the throwaway issue.

Trust the printed read-back line, not the exit code: the commands API returns 200 for commands it
did not apply. Never swallow stderr from a write — the first `--apply` failure printed only
`update failed`, while the parser error underneath named the problem exactly.

## 4. Verify a real install, and an update over an edited file

`npm test` covers the installer's plan; only a real install proves the copied tree runs.

```bash
rm -rf /tmp/rel && mkdir -p /tmp/rel
node bin/install.mjs --dir /tmp/rel --print   # config path only, writes nothing
```

Then a genuine install into `/tmp/rel`, and against it confirm:

- `_dev-workflow/`, every `.claude/skills/dev-*`, and the hook in `.claude/settings.json` exist;
- **no `node_modules` under `_dev-workflow/`** — the payload must stay dependency-free, or it breaks
  in every non-Node project;
- `node _dev-workflow/scripts/dev.mjs config` runs from the installed copy;
- editing a payload file by hand and re-running reports it as modified and **leaves it alone**;
  `--force` overwrites it;
- a pre-existing unrelated hook in `.claude/settings.json` survives the install.

## 5. Confirm what users will get

```bash
npm pack --dry-run
```

Check the file list covers `bin`, `lib`, `skills`, `scripts`, `hooks` and `examples`. Every one of
`lib`, `scripts`, `hooks` and `skills` is a directory the installer copies from: if npm does not
ship one, the install is silently incomplete. `tests/version.test.mjs` asserts this, but read the
list anyway — it is the last point at which a packaging mistake is cheap.

A full rehearsal of the version decision, without publishing anything:

```bash
GITHUB_TOKEN=$(gh auth token) NPM_TOKEN=<token> npx semantic-release --dry-run --no-ci
```

**Both tokens are required even for a dry run** — `@semantic-release/npm` verifies registry auth in
`verifyConditions`, which runs before the dry-run short-circuit, so omitting `NPM_TOKEN` fails with
`ENONPMTOKEN` and tells you nothing about the version. If you only want to check that the config and
plugins still resolve, that same failure is the proof: it is reached after all six plugins load.

## 6. Push, then watch it land

```bash
git push origin main
```

Ask before pushing. **Pushing is what publishes** — there is no gate after it.

```bash
gh run watch
```

When the run is green, confirm all four, because a half-finished release looks like a green run:

- the `vX.Y.Z` tag exists — `git fetch --tags && git tag --list 'v*' | tail -1`
- the GitHub Release has notes — `gh release view --web`
- npm has it — `npm view claude-dev-workflow version`
- **`package.json` on `main` was bumped** — `git pull && node -p "require('./package.json').version"`

The last one is the one that matters most and the easiest to miss. `main` is the distribution channel
for the `github:` install path, and `bin/lib/payload.mjs` stamps that version into every project's
manifest. If `@semantic-release/git` misfired, npm is correct while every `github:` install reports a
stale version forever.

## If a release fails midway

Do not hand-tag to "catch up" — the next run derives everything from the last tag, and a tag with no
matching npm version or no commit on `main` will skew it. Read the failed job, fix the cause, and
push again; semantic-release is idempotent and will resume from the last tag it actually created.
