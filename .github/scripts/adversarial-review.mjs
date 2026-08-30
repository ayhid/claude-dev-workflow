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
const MODEL = process.env.MISTRAL_MODEL || "mistral-small-latest";
const MAX_DIFF_CHARS = 120_000;
const MAX_CONTEXT_CHARS = 200_000;

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeFindings, renderReport } from "../../lib/review.mjs";

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

/**
 * One lens. Returns findings, never prose.
 *
 * `response_format: json_object` is the ask, but not the guarantee — a model can
 * still return a fenced block or an apology. Parsing is therefore forgiving and a
 * failure degrades to a reported lens rather than a failed run: a review that
 * loses one lens is worth more than one that posts nothing.
 */
async function call(system, user, lens) {
  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 4000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
  } catch (err) {
    return { name: lens, error: `request failed: ${err.message}` };
  }

  if (!res.ok) {
    const body = await res.text();
    return { name: lens, error: `HTTP ${res.status} — ${body.slice(0, 200)}` };
  }

  const content = (await res.json()).choices?.[0]?.message?.content ?? "";
  const parsed = parseFindings(content);
  if (!parsed) return { name: lens, error: "returned something that was not JSON" };

  const { findings, dropped } = normalizeFindings(parsed, lens);
  if (dropped) console.error(`${lens}: dropped ${dropped} finding(s) with nothing to act on`);
  return { name: lens, findings };
}

/** Tolerate a fenced block or leading prose around the object we asked for. */
function parseFindings(text) {
  const attempts = [text, text.replace(/^[\s\S]*?```(?:json)?\n/, "").replace(/```[\s\S]*$/, "")];
  const brace = text.indexOf("{");
  if (brace >= 0) attempts.push(text.slice(brace, text.lastIndexOf("}") + 1));
  for (const a of attempts) {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === "object") return v;
    } catch {
      /* try the next shape */
    }
  }
  return null;
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

const lenses = await Promise.all([
  call(BLIND, blindPayload, "blind"),
  call(EDGE, edgePayload, "edge"),
  call(AUDIT, auditPayload, "audit"),
]);

for (const l of lenses) if (l.error) console.error(`${l.name}: ${l.error}`);

const report = renderReport({
  lenses,
  model: MODEL,
  meta: {
    files: Number(process.env.CHANGED_FILES) || undefined,
    lines: Number(process.env.CHANGED_LINES) || undefined,
  },
});

writeFileSync(OUT, report);
console.error("Report written.");
