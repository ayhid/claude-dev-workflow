#!/usr/bin/env node
/**
 * Point the Homebrew formula at a published release. Repo-local; not shipped.
 *
 *   node tools/bump-formula.mjs <version>
 *
 * semantic-release cuts versions on every push to `main`, so the formula's
 * `url` and `sha256` have to follow by machine or they rot. The checksum comes
 * from the bytes the registry serves for that version — never from a local
 * `npm pack` — so the formula can only ever describe what `brew` will download.
 * The registry can lag a publish by a few seconds, so the fetch retries a
 * bounded number of times on a 404 and fails loudly after that.
 *
 * Pure parts (`bumpFormula`, `formulaVersion`, `tarballUrl`) are tested
 * offline; `fetchTarballSha256` takes its fetch injected for the same reason.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = 'claude-dev-workflow';
const FORMULA = join(dirname(fileURLToPath(import.meta.url)), '..', 'Formula', `${PACKAGE}.rb`);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const URL_LINE = /^(\s*url ")https:\/\/registry\.npmjs\.org\/claude-dev-workflow\/-\/claude-dev-workflow-([^"]+)\.tgz(")$/m;
const SHA_LINE = /^(\s*sha256 ")([0-9a-f]{64})(")$/m;

export const tarballUrl = (version) => `https://registry.npmjs.org/${PACKAGE}/-/${PACKAGE}-${version}.tgz`;

/** The version the formula's `url` names, or null if there is no such line. */
export function formulaVersion(text) {
  return text.match(URL_LINE)?.[2] ?? null;
}

/**
 * @returns {{ok: true, text: string, changed: boolean} | {ok: false, error: string}}
 */
export function bumpFormula(text, { version, sha256 }) {
  if (!SEMVER.test(String(version ?? ''))) return { ok: false, error: `not a version: "${version}"` };
  if (!/^[0-9a-f]{64}$/.test(String(sha256 ?? ''))) return { ok: false, error: `not a sha256: "${sha256}"` };
  if (!URL_LINE.test(text) || !SHA_LINE.test(text)) {
    return { ok: false, error: 'the formula has no url/sha256 lines in the shape this tool knows — edit it by hand' };
  }
  const next = text.replace(URL_LINE, `$1${tarballUrl(version)}$3`).replace(SHA_LINE, `$1${sha256}$3`);
  return { ok: true, text: next, changed: next !== text };
}

/**
 * sha256 of the registry's tarball for `version`. Retries on a 404 while the
 * registry catches up with a publish; anything else is an error at once.
 */
export async function fetchTarballSha256(version, { fetchImpl = fetch, attempts = 10, delayMs = 3000 } = {}) {
  const url = tarballUrl(version);
  for (let i = 1; i <= attempts; i++) {
    const res = await fetchImpl(url);
    if (res.ok) return createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
    if (res.status !== 404) throw new Error(`${url}: HTTP ${res.status}`);
    if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`${url}: still absent after ${attempts} attempts`);
}

async function main(version) {
  if (!version) {
    console.error('usage: node tools/bump-formula.mjs <version>');
    return 2;
  }
  const before = readFileSync(FORMULA, 'utf8');
  const sha256 = await fetchTarballSha256(version);
  const result = bumpFormula(before, { version, sha256 });
  if (!result.ok) {
    console.error(result.error);
    return 1;
  }
  if (!result.changed) {
    console.log(`formula already at ${version}`);
    return 0;
  }
  writeFileSync(FORMULA, result.text);
  console.log(`formula: ${formulaVersion(before)} → ${version} (${sha256.slice(0, 12)}…)`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2]).then((code) => process.exit(code), (err) => { console.error(err.message); process.exit(1); });
}
