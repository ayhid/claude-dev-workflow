---
name: release
description: Cut a release of the youtrack-workflow installer — bump the version, verify a clean install and the write paths against a real instance, tag and push. Use when asked to release, cut a version, or ship.
argument-hint: "[major|minor|patch, or an explicit version]"
---

# Release

Repo-local: this skill is development tooling for this repository and is **not** shipped to users.

`main` is the distribution channel — `npx github:ayhid/claude-youtrack-workflow` installs straight
from it — so whatever lands on `main` is live immediately. There is no staging step to catch a
mistake after the fact.

## 1. Decide the version

`$ARGUMENTS` is `major`, `minor`, `patch`, or an explicit `X.Y.Z`. If it is empty, read
`git log $(git describe --tags --abbrev=0)..HEAD --oneline` and propose one, then wait for
confirmation.

## 2. Bump the version

`package.json` → `.version` is the only place it lives; the installer stamps it into each
project's `_dev-workflow/_config/manifest.json` at install time.

Because installed projects are updated by **re-running the installer**, the version is how a user
tells what they have. A release that does not bump it leaves them unable to see they are stale.

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
node scripts/dev.mjs create "Release smoke test" "ignore me" Task Minor   # prints the new ID
node scripts/dev.mjs update <ID> "State In Progress"                      # check the read-back line
node scripts/dev.mjs update <ID> comment "smoke"
node scripts/dev.mjs sync --apply                                          # if there is real drift
```

Then **re-run each one** to confirm it is idempotent, and close the throwaway issue.

Trust the printed read-back line, not the exit code: the commands API returns 200 for commands it
did not apply. Never swallow stderr from a write — the first `--apply` failure printed only
`update failed`, while the parser error underneath named the problem exactly.

## 5. Verify a real install, and an update over an edited file

`npm test` covers the installer's plan; only a real install proves the copied tree runs.

```bash
rm -rf /tmp/rel && mkdir -p /tmp/rel
node bin/install.mjs --dir /tmp/rel --print   # config path only, writes nothing
```

Then a genuine install into `/tmp/rel`, and against it confirm:

- `_dev-workflow/`, the four `.claude/skills/dev-*`, and the hook in `.claude/settings.json` exist;
- **no `node_modules` under `_dev-workflow/`** — the payload must stay dependency-free, or it breaks
  in every non-Node project;
- `node _dev-workflow/scripts/dev.mjs config` runs from the installed copy;
- editing a payload file by hand and re-running reports it as modified and **leaves it alone**;
  `--force` overwrites it;
- a pre-existing unrelated hook in `.claude/settings.json` survives the install.

## 6. Commit, tag, push

Commits in this repo use the `chore(no-ticket):` escape hatch: this repo has no YouTrack project
of its own.

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

Check the file list covers `bin`, `lib`, `skills`, `scripts`, `hooks` and `examples`. Every one of
`lib`, `scripts`, `hooks` and `skills` is a directory the installer copies from: if npm does not
ship one, `npx` installs an incomplete project. `tests/version.test.mjs` asserts this, but read the
list anyway — it is the last point at which a packaging mistake is cheap.
