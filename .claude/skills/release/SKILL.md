---
name: release
description: Cut a release of the youtrack-workflow plugin — bump both manifests, verify the write paths against a real instance, tag and push. Use when asked to release, cut a version, or ship the plugin.
argument-hint: "[major|minor|patch, or an explicit version]"
---

# Release the plugin

Repo-local: this skill is development tooling for this repository and is **not** shipped to users.

`main` is the distribution channel for both install paths — `npx github:ayhid/…` and
`/plugin marketplace add` — so whatever lands on `main` is live immediately. There is no staging
step to catch a mistake after the fact.

## 1. Decide the version

`$ARGUMENTS` is `major`, `minor`, `patch`, or an explicit `X.Y.Z`. If it is empty, read
`git log $(git describe --tags --abbrev=0)..HEAD --oneline` and propose one, then wait for
confirmation.

## 2. Bump **both** manifests

The version lives in two places and they must agree — a mismatch ships a plugin whose manifest
lies about what it is, and nothing at runtime notices:

- `package.json` → `.version`
- `.claude-plugin/plugin.json` → `.version`

`tests/version.test.mjs` asserts they match, so `npm test` catches a half-done bump.

## 3. Run the checks

```bash
npm test
```

Lint, unit tests and the hook table test. All must pass. Do not proceed on a failure, and do not
summarise a failure away — report the output.

## 4. Verify the write paths for real

**A dry run proves nothing about a write path.** `yt sync --apply` once shipped with a command the
API rejected while every dry run had reported the correct plan. The read paths (`config`, `fetch`,
`create --dup-check`, a `sync` dry run) can be exercised freely; the writes cannot be verified
without writing.

So, against a real instance, if anything touching a write path changed:

```bash
node scripts/yt.mjs create "Release smoke test" "ignore me" Task Minor   # prints the new ID
node scripts/yt.mjs update <ID> "State In Progress"                      # check the read-back line
node scripts/yt.mjs update <ID> comment "smoke"
node scripts/yt.mjs sync --apply                                          # if there is real drift
```

Then **re-run each one** to confirm it is idempotent, and close the throwaway issue.

Trust the printed read-back line, not the exit code: the commands API returns 200 for commands it
did not apply. Never swallow stderr from a write — the first `--apply` failure printed only
`update failed`, while the parser error underneath named the problem exactly.

## 5. Verify the zx delivery

The dependency reaches users through `/yt-init` and `bin/install.mjs`, with `scripts/bootstrap.mjs`
as the fallback. Confirm the fallback still works, because a plugin upgrade lands in a fresh
directory with no `node_modules`:

```bash
rm -rf node_modules
node scripts/yt.mjs config          # must work — no dependencies
node scripts/yt.mjs sync            # must install zx itself, then run
npm install                          # restore
```

## 6. Commit, tag, push

Commits in this repo use the `chore(no-ticket):` escape hatch — the plugin is installed at user
scope, so its own commit hook applies here.

```bash
git commit -am "chore(no-ticket): release <version>"
git tag -a v<version> -m "<version>"
git push origin main --follow-tags
```

Ask before pushing. Pushing is what publishes.

## 7. Confirm what users will get

```bash
npm pack --dry-run
```

Check the file list covers `bin`, `lib`, `skills`, `scripts`, `hooks`, `examples`,
`.claude-plugin` — and that `lib/` is present, since both `bin/` and `scripts/` import from it.
