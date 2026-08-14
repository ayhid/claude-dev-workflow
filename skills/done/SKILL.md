---
name: done
description: Finish work on the current branch's YouTrack issue — verify acceptance criteria, run the project's checks, and on confirmation move the ticket to the configured done state with a summary comment. Use when the user says they are done or types /done.
argument-hint: "[optional ISSUE-ID]"
---

# /done — close out the current branch's issue

## 0. Load the project's workflow config

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/yt-config.sh"
```

Gives the state ladder (specifically which state means *finished* on this project), the per-repo
check commands, the commit pattern, and the ticket language. If it reports `MISSING`, run
`/yt-init` first and stop.

## 1. Get the issue ID

If `$ARGUMENTS` carries one, use it. Otherwise infer it from the branch name — branches created
by `/task` follow the configured pattern, `<ISSUE-ID>-<slug>` by default:

```bash
git -C <repo> branch --show-current
```

Take the leading `[A-Z][A-Z0-9]*-[0-9]+`. Determine `<repo>` from where the work happened —
check every configured repo if unsure.

If the branch name carries no issue ID, **ask the user for it. Do not guess**, and do not fall
back to the most recent ticket you happen to have seen.

## 2. Re-read the ticket

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/yt-fetch.sh" <ISSUE-ID>
```

Re-read rather than trusting earlier context: comments may have been added while you worked,
and the state may have moved underneath you.

## 3. Verify each acceptance criterion

Walk the checklist one criterion at a time. For each, state **met** or **not met** and cite
concrete evidence — a file and line, a passing test, or command output.

If any criterion is unmet, say so plainly and stop. Do not close a ticket whose criteria are
not satisfied; report what is missing and let the user decide.

## 4. Run the project's checks

Run the checks configured for the repo the work landed in, with its configured `env` prefix.
If none are configured, find the project's own test and lint entry points and say which you ran
— and watch for watch-mode targets that never exit.

Report failures with their output. A failing suite blocks closing the ticket.

## 5. Confirm the diff is committed

```bash
git -C <repo> status --short
git -C <repo> log --oneline <base>..HEAD
```

Every commit should match the configured commit pattern and carry the issue ID. Uncommitted work
means the ticket is not done — surface it rather than closing over it.

## 6. Ask, then close

Draft a summary comment **in the configured ticket language**: what changed, which files, how it
was verified. Show it to the user and ask whether to post it.

**Only on explicit confirmation:**

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/yt-update.sh" <ISSUE-ID> "State <configured states.done>" "<summary>"
```

Confirm the read-back line reports that state. If it reports anything else, the command did not
apply — report that rather than assuming success. Use only state names from the configured
ladder; a state YouTrack does not recognise fails, sometimes silently.

Pushing the branch and opening a PR are separate actions; ask before doing either.
