# 0003. Ship subagent definitions as a third owned root, with a model per task class

- Status: accepted
- Date: 2026-09-03

## Context

Measured over 54 sessions with `tools/profile.mjs`: cache reads are 69% of cost-weighted spend,
cache writes 17%, output 15%, and the Agent tool was used 20 times in 7,900 turns. Cost is context
multiplied by turns, and nearly everything a skill reads — a document, a diff with its surrounding
source, a repository probe — enters the main session's context and is re-read on every turn after,
at the main model's price. Two skills already delegated (`dev-ingest-docs` reads documents in
subagents; `dev-review` runs its blind lens in one) and neither named a model, so both ran on
whatever the session ran on.

Claude Code lets a dispatch pick a model per call, and lets a definition file under
`.claude/agents/` pin a model, allowlist tools and carry a fixed system prompt. A subagent starts
from its own small context, returns only its final message, and pays its own prompt-cache write.
So delegation wins exactly when the material is large or the step repeats, and the saving is
larger the cheaper the model and the more stable the agent's prefix. The constraint this forces: the
installer writes to exactly two roots today (`_dev-workflow/**`, `.claude/skills/dev-*/**`), and a
definition file lives in neither.

## Options considered

- **No definitions; pass `model` inline on each dispatch and use the built-in Explore agent** —
  rejected. No installer change, but no tool allowlist per task (a reader that may write is not a
  reader), no fixed system prompt (so no cached prefix across dispatches of the same job), and the
  model choice scattered through eleven SKILL.md files as prose the next edit can drop.
- **Definitions written under `_dev-workflow/agents/`** — rejected. Inside the root we own, but
  not where Claude Code reads agents from, so they would be documentation of agents rather than
  agents.
- **One model for every agent** — rejected. The cost difference between the models is 5x on
  input and output, and the task classes differ in what a wrong answer costs: a reader's output is
  refused by the tool when it is malformed, a reviewer's is read by a person, a decision with the
  user cannot be delegated at all. One model would be either too expensive for the first or too
  weak for the second.
- **Ship `agents/dev-<name>.md` to `.claude/agents/`, a third owned root, with a model per task
  class** — chosen. `isOwnedPath` accepts exactly `.claude/agents/dev-*.md`, one file per agent,
  and every write, delete and orphan sweep goes through the same predicate as before. The classes:
  *find and report* (read, extract, verify, probe — a checkable output) on the cheapest model;
  *judge bounded material* (a lens over a diff, a pair of documents, a criterion against a change)
  on the middle model; *decide with the user* (criteria, arbitration, options, plans) never
  delegated. Each definition keeps its invariant rules first and its per-dispatch input last, so
  repeated dispatches share a cached prefix.

## Consequences

Easy: a skill dispatches by name and inherits model, tools and rules; a new task class is one
file; the main session keeps one model and one effort, so its own cache keeps hitting; the
profiler can attribute spend per model once it learns to read subagent transcripts.

Expensive: every subagent pays a prompt-cache write of its own, so a one-line step must not be
delegated — the rule is large or repeated reads only. The namespace is now three roots, and the
sentence in `CLAUDE.md` that said "exactly two" is the sentence this record changes.

Foreclosed: a per-project choice of model is not in the definitions yet; if the profiler shows it
matters, it becomes a config key that the installer renders into the frontmatter, not a second
copy of the class-to-model rule in a skill.
