---
name: dev-lint-rules
description: Turn a project's stated conventions into rules its linter can decide, each with the count of what it would flag today — and name the ones no linter can settle as a hook, a claim, or noise. Use before writing a conventions document, when a review keeps restating the same rule, or when the user types /dev-lint-rules.
argument-hint: "[optional: a surface to focus on, e.g. naming, imports, commits]"
---

# /dev-lint-rules — a convention nothing enforces is a convention nobody follows

A coding guideline is one of two things.

It is **deterministic**, in which case a linter can decide it — and a document restating it is a
second, weaker copy of a rule that already has an enforcer, going stale the first time the rule
changes. Or it is **not** deterministic, in which case it is unfalsifiable prose: "keep functions
small", "prefer clarity", "handle errors properly". Nobody can be shown to have violated it, so
nobody is.

That is why the documentation set has no `conventions.md` — `renderDocument` has no parameter a
paragraph could be passed through, so the second kind is not discouraged there, it is
unrepresentable. But it leaves a hole, and this skill is the hole. Every project accumulates stated conventions — in
`CLAUDE.md`, in `CONTRIBUTING.md`, in a reviewer's head — and nothing turns them into rules. So they
are restated in review, forever, and a session that never reads them violates them silently. The
convention exists; the enforcer does not.

`$ARGUMENTS` may name one surface to focus on — `naming`, `imports`, `commits`. If empty, do all of them.

## 1. Read what the project already enforces

One command, and do not assemble any of it by hand:

```bash
node "${CLAUDE_PROJECT_DIR}/_dev-workflow/scripts/dev.mjs" rules
```

It reports four things: the linters configured and the config files that say so, the check commands
from `.dev-workflow.json`, the documents that state conventions, and the `intent` claims in the
documentation ledger. Add `--json` when you want the per-linter count recipe as data.

Two lines change what you do next:

- **`not linted at all`** — a language in this tree that no configured linter covers. Nothing can be
  proposed for it, because there is no config to propose into. Say so and name the standard tool;
  do not write a config file for a linter nobody installed.
- **`no linter is configured`** — the same, for the whole project.

**A rule that already exists is never proposed again.** The command is what makes that a fact rather
than a hope, so read its output before reading anything else. If a convention is already enforced,
the finding is that it is enforced — say so in one line and move on.

## 2. Read what the project states

Now the part no command can do. Open each document §1 listed and pull out every **imperative** — a
sentence that tells somebody to do or not do something. One line each, with its source:

```
CLAUDE.md:42        every git call goes through one git() wrapper
CONTRIBUTING.md:17  exercise a write path for real; a dry run proves nothing
```

Read the `intent` claims the same way. They are already one statement each with an attributed
source, which is the shape a convention wants.

**This is where `$ARGUMENTS` applies.** Given a surface, keep only the imperatives about it and say
how many you set aside — a filtered pass that does not say what it skipped reads like a complete
one. Given nothing, keep them all.

Two things that are not conventions, and picking them up is the commonest way this goes wrong:

- **A description of how the system works** is not a rule. "Sessions are in memory" states a fact
  about today; "sessions must not be written to disk" is the rule. Only the second can be violated.
- **A refusal already implemented in code** is enforced by the code. It goes in the enforced list,
  not the candidate list.

## 3. Propose rules, as one batch, for approval

For each convention that a linter can decide, give three things and never fewer:

| | |
|---|---|
| the rule | in the project's own linter's config language, ready to paste |
| the convention | the line from §2 it comes from, with its source |
| **the count** | how many existing violations it would flag today |

The count is not decoration. **A rule that lights up four hundred existing violations is a decision,
not a config line**, and the number is the only thing that makes it one — the user is choosing
between fixing four hundred call sites, a warning nobody reads, and not having the rule.

Produce it by running the rule alone against the existing tree. `dev.mjs rules --json` prints the
invocation for each configured linter with `<RULE>` to substitute; it is the tool's own
single-rule flag, so what it prints *is* the count:

```bash
npx --no-install eslint . --no-config-lookup --rule '{"no-restricted-imports": "error"}'   # flat config
ruff check --select ANN --statistics .
rubocop --only Style/GuardClause --format offenses
golangci-lint run --disable-all -E errcheck ./...
```

`--json` also reports each linter's `placeholder`, and it is not decoration. Almost everywhere
`<RULE>` is a rule id and the severity is a flag; commitlint's rules are **tuples whose third
element is the value**, so `placeholder: entry` means you substitute the whole entry —
`"type-enum": [2, "always", ["feat", "fix"]]`, never the bare name. A `type-enum` with no enum
behind it matches nothing and counts zero, which reads exactly like a rule nobody violates.

The recipes pass `--no-install` for the same reason: `npx eslint` on a project whose own copy is not
installed downloads whatever is latest, and a count from a different major version is a wrong count.
Failing loudly is the honest outcome — the fix is to install the project's dependencies, not to
count with a different tool.

If the project's linter is not one the command knows, ask the user for the equivalent invocation
rather than guessing at a flag. A count produced by a command that does not do what you think is
worse than no count, because nobody re-checks a number.

**Propose no rule for a convention you cannot state as a rule.** A regex that approximates a
guideline is worse than no rule: it is wrong in exactly the cases nobody looks at, and every
false positive spends somebody's attention on the linter rather than the code.

## 4. Report what no rule can decide — the valuable half

Everything left over. Each one is one of three things, and say which it looks like:

| | It is a **hook** | It is an **`intent` claim** | It is **noise** |
|---|---|---|---|
| what it means | deterministic, but outside the linter's reach — a commit message, a file's location, a bypassed guard | a real design position worth recording and attributing | a sentence that has never decided anything |
| the evidence | you can write the check in bash, and it would pass or fail | somebody would defend it, and it has an author | nobody can say what violating it looks like |
| where it goes | `.claude/hooks/`, registered in `settings.json` | `dev.mjs docs record` — one claim, `kind: intent`, with a source | delete it |

Be honest about the third column. **A convention that is none of the three has been restated in
review for years and will be restated tomorrow** — that is the finding, and softening it into "could
be documented better" is how it survives another year.

## What this skill refuses

- **It never edits a linter config, a `CLAUDE.md`, or anything else without approval of the batch.**
  Switching a rule on changes what CI does. That is the user's call, and §3's violation count is
  what they need to make it. Present everything, wait, then write only what was approved.
- **It proposes no rule for a convention it cannot state as a rule** — see §3.
- **It does not invent a linter.** A project with no lint setup is told so, and told what the
  standard one for its language is. It does not get a config file for a tool that is not installed:
  a rule that will never run is worse than an absent one, because it looks like coverage.
- **It does not write the document it exists to replace.** If the leftovers in §4 are large and
  interesting, that is not a `conventions.md` — they are claims, hooks, or deletions.
