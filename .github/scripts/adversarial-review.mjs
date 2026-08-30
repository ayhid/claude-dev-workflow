#!/usr/bin/env node
/**
 * Three-layer adversarial review against the Mistral API.
 *
 * Each layer is one chat completion with a deliberately different payload.
 * The blind layer receives the diff and nothing else. That is not a prompt
 * instruction the model could ignore, it is the entire content of its context.
 *
 * Env:
 *   MISTRAL_API_KEY   required
 *   MISTRAL_MODEL     optional, defaults to mistral-large-latest
 *   DIFF_PATH         required, path to the unified diff
 *   CONTEXT_PATH      optional, concatenated source of the changed files
 *   INTENT_PATH       optional, PR title + body + linked issue text
 *   OUT_PATH          optional, defaults to ./review.md
 */

const API_URL = "https://api.mistral.ai/v1/chat/completions";
const MODEL = process.env.MISTRAL_MODEL || "mistral-large-latest";
const MAX_DIFF_CHARS = 120_000;
const MAX_CONTEXT_CHARS = 200_000;

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The lenses are not defined here. They live in skills/dev-review/lenses/ and are
// the same files the /dev-review skill reads, so a lens edited for one consumer
// cannot silently diverge from the other. Text only, no frontmatter.
const LENS_DIR = fileURLToPath(new URL("../../skills/dev-review/lenses/", import.meta.url));

function lens(name) {
  const path = `${LENS_DIR}${name}.md`;
  if (!existsSync(path)) {
    console.error(`Missing lens: ${path}`);
    process.exit(1);
  }
  return readFileSync(path, "utf8").trim();
}

const BLIND = lens("blind");
const EDGE = lens("edge");
const AUDIT = lens("audit");

function read(path, cap) {
  if (!path || !existsSync(path)) return "";
  const raw = readFileSync(path, "utf8");
  return raw.length > cap
    ? raw.slice(0, cap) + "\n\n[truncated, payload exceeded the cap]"
    : raw;
}

async function call(system, user, label) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 3000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    return `_${label} failed: HTTP ${res.status}._\n\n\`\`\`\n${body.slice(0, 500)}\n\`\`\``;
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || "_Empty response._";
}

const OUT = process.env.OUT_PATH || "review.md";

const diff = read(process.env.DIFF_PATH, MAX_DIFF_CHARS);
if (!diff) {
  // Still write the report. Callers post OUT_PATH unconditionally, and a
  // missing file fails the run louder than the empty diff deserves.
  writeFileSync(
    OUT,
    "## Adversarial review\n\nNo reviewable diff between the base and head commits. Nothing was sent to the model.\n",
  );
  console.error("No diff to review.");
  process.exit(0);
}

const context = read(process.env.CONTEXT_PATH, MAX_CONTEXT_CHARS);
const intent = read(process.env.INTENT_PATH, 20_000);

// The three payloads. Note what each one does NOT contain.
const blindPayload = `<diff>\n${diff}\n</diff>`;

const edgePayload =
  `<diff>\n${diff}\n</diff>\n\n<changed_files>\n${context}\n</changed_files>`;

const auditPayload =
  `<intent>\n${intent || "No intent was supplied. This is itself your first finding."}\n</intent>\n\n` +
  `<diff>\n${diff}\n</diff>\n\n<changed_files>\n${context}\n</changed_files>`;

const [blind, edge, audit] = await Promise.all([
  call(BLIND, blindPayload, "Blind hunter"),
  call(EDGE, edgePayload, "Edge case hunter"),
  call(AUDIT, auditPayload, "Acceptance auditor"),
]);

const report = `## Adversarial review

Three passes over the same diff, run independently. Model: \`${MODEL}\`.

<details open>
<summary><b>Blind hunter</b> — reviewed the diff with no PR description, issue or commit messages</summary>

${blind}

</details>

<details open>
<summary><b>Edge case hunter</b> — the inputs that break it</summary>

${edge}

</details>

<details open>
<summary><b>Acceptance auditor</b> — code against intent, and intent against itself</summary>

${audit}

</details>

---

**Triage.** Sort each finding into one bucket before acting on it.
_intent-gap_: the code is wrong, fix the code.
_bad-spec_: the code faithfully implements a wrong spec, fix the spec first.
_patch_: a real local defect, fix it now.
_deferred_: legitimate but out of scope, open an issue.

A finding raised only by the blind hunter that the intent already covers is usually a
readability problem, not a defect. A finding raised by both the blind hunter and the
auditor is almost always real.
`;

writeFileSync(OUT, report);
console.error("Report written.");
