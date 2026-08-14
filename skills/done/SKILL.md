---
name: done
description: Finish work on the current branch's YouTrack issue — verify acceptance criteria, run the project's checks, and on confirmation move the ticket to the configured done state with a summary comment. Use when the user says they are done or types /done.
argument-hint: "[optional ISSUE-ID]"
---

# /done — close out the current branch's issue

## 0. Load the project's workflow config

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/yt.mjs" config
```

Gives the state ladder (specifically which state means *finished* on this project), the per-repo
check commands, the commit pattern, and the ticket language. If it reports `MISSING`, run
`/yt-init` first and stop.

Then reconcile the board before trusting any state you are about to read:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/yt.mjs" sync
```

Dry run — it reports drift and changes nothing. A ticket sitting in the review state with a merged
PR simply means nobody has run this since the merge, not that the work is unfinished.

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
node "${CLAUDE_PLUGIN_ROOT}/scripts/yt.mjs" fetch <ISSUE-ID>
```

Re-read rather than trusting earlier context: comments may have been added while you worked,
and the state may have moved underneath you.

## 3. Verify each acceptance criterion

Walk the checklist one criterion at a time. For each, state **met** or **not met** and cite
concrete evidence — a file and line, a passing test, or command output.

**When a criterion is about deployed behaviour, a merged PR is not evidence.** Tickets often close
on "fixed *and* verified in the environment". Merging proves the code landed, not that the running
system changed. Verify the artifact that is actually serving:

- fetch the deployed asset and confirm it carries the fix (a distinguishing symbol from the diff
  survives minification more often than you would expect);
- exercise the real thing — load the page, call the endpoint — and compare against the numbers in
  the ticket's reproduction steps.

Quote the before-and-after. "The cycle that repeated indefinitely now fires once" is evidence;
"deployed" is not.

If any criterion is unmet, say so plainly and stop. Do not close a ticket whose criteria are
not satisfied; report what is missing and let the user decide.

## 4. Run the project's checks

Run the checks configured for the repo the work landed in, with its configured `env` prefix.
If none are configured, find the project's own test and lint entry points and say which you ran
— and watch for watch-mode targets that never exit.

Report failures with their output. A failing suite blocks closing the ticket — **unless the
failures are pre-existing**, and you have shown that rather than assumed it.

To tell the two apart, compare what fails against what the branch changed:

```bash
git -C <repo> show --name-only --format= <commit>   # what this work touched
```

A failure in a file or module the branch never touched is pre-existing. Say so explicitly, name
the module, and cite the commit's file list as the evidence. Then run the suite that *does* cover
the change on its own and report that result separately — "39 suites green in the plugin under
test, 3 unrelated failures elsewhere" is an honest close-out; "tests pass" is not.

Never wave a failure away without doing this comparison. If the failing files overlap the change
at all, treat it as caused by the work and stop.

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

**Only on explicit confirmation**, post the summary and let the reconciler move the state — it
derives the target from the merged PR rather than from your reading of the ladder:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/yt.mjs" update <ISSUE-ID> comment "<summary>"
node "${CLAUDE_PLUGIN_ROOT}/scripts/yt.mjs" sync --apply
```

If the PR is not merged yet there is nothing for the reconciler to act on, and the ticket
correctly stays where it is. Apply the transition by hand only when the project genuinely has no
PR for this work:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/yt.mjs" update <ISSUE-ID> "State <configured states.done>" "<summary>"
```

Confirm the read-back line reports that state. If it reports anything else, the command did not
apply — report that rather than assuming success. Use only state names from the configured
ladder, and observe the brace rule (see `/task` §5). Prefer `yt.mjs sync`, which applies it for
you; a state YouTrack does not recognise fails, sometimes silently.

Pushing the branch and opening a PR are separate actions; ask before doing either.
