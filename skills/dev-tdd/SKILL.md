---
name: dev-tdd
description: Drive an agreed acceptance criterion through red/green/refactor — a test confirmed to fail for the intended reason before any production code, then the least code that passes it. Use when /dev-task hands off at implementation, or when the user types /dev-tdd.
argument-hint: "[the criterion to drive, or empty for the next unmet one]"
---

# /dev-tdd — the failing test comes first, one criterion at a time

`$ARGUMENTS` is either one acceptance criterion, or empty — in which case take the next unmet one.

`/dev-task` §6 hands off here, and everything below runs **in the checkout `/dev-task` §5 printed**,
not in the repo root.

## The criteria are already agreed — this skill does not touch them

`/dev-task` §2 settled what "done" means and wrote it as `AC1`, `AC2`, … Use those ids, spelled
exactly as they are written there. There is no criteria step in this skill and there must not be
one: a second AC vocabulary beside the first is drift, and the list §7 verifies against is the
list §2 produced.

If you arrived here without one — the user typed `/dev-tdd` on its own — get the list before
writing anything: `/dev-task` §1 fetches the ticket and §2 restates its criteria. Do not invent
criteria to have something to drive.

## 0. Load the project's workflow config

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" config
```

Three things here decide how the loop runs: the repo's **checks** (the command that runs the
tests), the **commit** pattern, and the `tdd:` line.

`tdd: off` means the project does not want this loop by default, so `/dev-task` §6 will not have
sent you here. A user who typed `/dev-tdd` anyway is asking for it on this ticket — say the project
has it switched off in one line, and carry on. The switch is a default, not a refusal.

## 1. Take one criterion

The smallest unmet one. Name it — `AC3: the parser rejects a brace around a single-word value` —
and drive only that. One at a time is the whole mechanism: a suite that goes red after a batch of
changes tells you something broke, and a test that goes red on its own tells you what.

## 2. Red — write the test, run it, and read the failure

Write the test for that criterion and **run it before writing any production code**.

A test that fails is not yet a red test. It has to fail **for the intended reason**: the assertion
it makes about the behaviour is the thing that did not hold. Read the message.

- `TypeError: parse is not a function`, `Cannot find module`, a typo in a fixture — that is a
  broken test, not a red one. It would pass the moment the import resolves, whatever the code does.
  Fix it and run again.
- Assert on the value the code produced, not on the shape of the call. A test that only proves a
  function was reached proves nothing about the criterion.

**If it passes on its first run, stop.** Two possibilities, and they are not the same:

- The behaviour already exists. Then the criterion is met — say so, cite the file and line that
  implements it, and take the next one. Do not write code to pass a test that already passed.
- The test asserts nothing that could have failed. Rewrite it until it can.

Never treat an unexplained green as progress.

## 3. Green — the least code that passes it

- Write only enough to make that test pass. Anything else you can see coming is a later criterion
  or a later test; it does not get written now on the grounds that you are already in the file.
- **Do not edit the test to fit the code.** If the test was wrong, say so out loud, correct it, and
  go back to §2 for a fresh red — a test corrected while the code is being written proves nothing
  about the order they were written in.
- Never delete, skip or `.only` a failing test to reach green.
- Run the whole file, not just the new test. Code that passes one test often breaks its neighbours,
  and finding that out now is cheaper than finding it out at §7.

## 4. Refactor — only while green

Now clean it up: the duplication the minimal version left, the name that was a placeholder, the
branch that belongs in a helper. Re-run the tests after each change.

If it goes red, the refactor caused it. Undo it and try a smaller one rather than debugging
forward — the last green state is a known-good position and you should not give it up.

Nothing new goes in here. Behaviour no test covers is not a refactor; it is §1 with a criterion
nobody agreed.

## 5. Commit, then take the next one

Commit the test and the code it drove **together**, in the configured commit pattern with the
ticket id. One commit per criterion, or per tight red/green pair — the point is that a reader sees
the test arrive with the behaviour rather than a fortnight later.

Then back to §1 until every criterion has been through the loop, and on to `/dev-task` §7. That
step is not a formality just because the tests are green: it re-reads each criterion against the
code and cites the evidence, and a criterion can be technically passing and still not be what the
ticket asked for.

## When the loop genuinely does not apply

Say so rather than performing it. A test written to have written a test is worse than none — it
has to be maintained and it protects nothing.

- **No behaviour to assert.** A documentation edit, a renamed config key, a comment that was
  wrong. Make the change; the evidence at §7 is the file, not a test.
- **The failure is not observable from a test the project can run** — an install path, a hook that
  fires inside the agent harness, a CI-only step. The evidence is then the command output, run for
  real. A dry run proves nothing about a write path.
- **Untested legacy code with no seam.** Write a characterisation test of what it does *today*
  first, so the refactor has something to fail against, and treat that as the red.

In every one of those cases, state which it is and why. An honest "AC4 has no test, here is the
output that shows it works" is worth more than a green assertion nobody believes.
