/**
 * What an issue filed against this project must look like.
 *
 * A repository that ships `.github/ISSUE_TEMPLATE/` is stating the shape every
 * issue must have, and `gh issue create --body-file -` bypasses that statement
 * by construction — templates apply only to a body composed interactively. So
 * the shape is read here and enforced by `dev.mjs create` before it files,
 * from three sources in a fixed order:
 *
 *   1. the checkout — `.github/ISSUE_TEMPLATE/*.{md,yml,yaml}`, then the three
 *      legacy single-file locations;
 *   2. the tracker, via `provider.templates()` — the repo issues are filed
 *      against may not be the one checked out — only when the checkout has
 *      none and the backend declares `capabilities.issueTemplates`;
 *   3. the shipped defaults below, one per issue type, when the repo has none.
 *
 * Both of GitHub's formats normalise to one shape: `{name, filename, title,
 * labels, about, sections, text, format}`. `sections` is the list of headings
 * a body must carry — the `##`/`###` headings of a markdown template, the
 * `attributes.label` of every non-`markdown` item of an issue form (GitHub
 * renders those as `### <label>`).
 *
 * ## Strictness differs by source, deliberately
 *
 * A **repo** template is satisfied in full: every section is required and
 * there is no bypass flag, because a template that does not fit the issue is a
 * template to fix. A **shipped default** requires `## Acceptance criteria`,
 * present and non-empty, and warns about everything else: criteria are the
 * one section with a hard downstream consumer (`/dev-tdd`, `/dev-done`), and
 * refusing a one-line bug for an empty `## Environment` would teach people to
 * type filler. A repo template with no criteria section is not overridden —
 * the project stated its shape — but `validateBody` warns once, so the gap is
 * visible before `/dev-done` discovers it.
 *
 * ## Not the inference rule 2 forbids
 *
 * Picking among several *repo* templates unasked would be a guess about the
 * project's own statement, so with several the caller names one. A shipped
 * default is this tool's stated default for a type, printed by `--template`
 * and named on stderr on every create — nobody's statement is being inferred.
 *
 * ## The YAML here is a subset, and it refuses what it cannot read
 *
 * There is no YAML parser in node: builtins, and the payload takes no
 * dependencies. What is read is exactly what GitHub's own schema puts at the
 * top level (`name`, `title`, `labels`, `about`/`description`) plus `body[]`
 * items' `type` and `attributes.label`; block scalars are skipped, everything
 * else is ignored. One refusal, with a line number: a body item without a
 * `type`, since without it the item cannot be told from a `markdown` note.
 *
 * node: builtins only — this ships into projects of any language.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Where GitHub reads templates from, in the order this tool consults them. */
export const TEMPLATE_DIR = '.github/ISSUE_TEMPLATE';
export const LEGACY_TEMPLATE_FILES = ['.github/ISSUE_TEMPLATE.md', 'docs/ISSUE_TEMPLATE.md', 'ISSUE_TEMPLATE.md'];

const CRITERIA = 'acceptance criteria';

/** Headings compared: trimmed, lowercased, whitespace collapsed, no trailing colon. */
const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').replace(/:$/, '').toLowerCase();

const isCriteria = (heading) => norm(heading) === CRITERIA;

// --- the shipped defaults -------------------------------------------------------

const defaultTemplate = (name, sections) => ({
  name,
  filename: null,
  title: '',
  labels: [],
  about: `shipped default for ${name}`,
  sections,
  format: 'default',
  text: `${sections
    .map((s) => (isCriteria(s) ? `## ${s}\n- [ ] AC1: \n` : `## ${s}\n\n`))
    .join('\n')}`,
});

/**
 * One per issue type this tool knows something about, and a generic one for
 * every other configured type: a project's `Task` or `Epic` must not silently
 * get the bug skeleton, and inventing an `## Out of scope` for an `Epic`
 * would be a guess.
 */
export const DEFAULT_TEMPLATES = Object.freeze({
  Bug: defaultTemplate('Bug', [
    'Symptom',
    'Steps to reproduce',
    'Expected vs actual',
    'Environment',
    'Suspected area',
    'Acceptance criteria',
    'Session context',
  ]),
  Feature: defaultTemplate('Feature', ['Problem', 'Proposed change', 'In scope', 'Out of scope', 'Acceptance criteria']),
  generic: defaultTemplate('generic', ['Problem', 'Proposed change', 'Acceptance criteria']),
});

/** The shipped default for an issue type. Compared ignoring case; unknown → generic. */
export function defaultTemplateFor(type) {
  const key = Object.keys(DEFAULT_TEMPLATES).find(
    (k) => k !== 'generic' && k.toLowerCase() === String(type ?? '').trim().toLowerCase(),
  );
  return DEFAULT_TEMPLATES[key ?? 'generic'];
}

// --- the YAML subset ---------------------------------------------------------------

/** A `# comment` outside quotes, dropped. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

const unquote = (v) => {
  const s = String(v ?? '').trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.endsWith(s[0])) return s.slice(1, -1);
  return s;
};

/** `a, b` or `[a, "b c"]` as a list; a block list is assembled by the walker. */
const splitList = (v) => {
  const s = String(v ?? '').trim();
  const inner = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  return inner.split(',').map(unquote).filter(Boolean);
};

const isBlockScalar = (v) => /^[|>]/.test(String(v ?? '').trim());

/**
 * One pass over a YAML mapping, reading the top-level scalar keys, a top-level
 * block list, and the `body:` list's items. Everything else is walked past.
 *
 * @returns {{ok: true, top: object, items: Array<{line: number, type: ?string, label: ?string}>} | {ok: false, error: string}}
 */
function walkYaml(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const top = {};
  const items = [];
  let inBody = false;
  let item = null;
  let itemIndent = -1;
  let nest = null; // the item key whose children we are under (`attributes`)
  let nestIndent = -1;
  let listKey = null; // a top-level key collecting a block list
  let skipDeeperThan = -1; // inside a block scalar

  for (let n = 1; n <= lines.length; n += 1) {
    const raw = lines[n - 1];
    const stripped = stripComment(raw);
    if (!stripped.trim()) continue;
    const indent = stripped.match(/^ */)[0].length;
    const body = stripped.trim();

    if (skipDeeperThan >= 0) {
      if (indent > skipDeeperThan) continue;
      skipDeeperThan = -1;
    }

    if (indent === 0) {
      inBody = false;
      item = null;
      listKey = null;
      const kv = body.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/);
      if (!kv) continue;
      const [, key, value = ''] = kv;
      if (key === 'body') {
        inBody = true;
        itemIndent = -1;
        continue;
      }
      if (isBlockScalar(value)) {
        skipDeeperThan = 0;
        continue;
      }
      if (value === '') {
        listKey = key;
        top[key] = [];
        continue;
      }
      top[key] = key === 'labels' ? splitList(value) : unquote(value);
      continue;
    }

    if (listKey && !inBody) {
      const li = body.match(/^-\s+(.*)$/);
      if (li) top[listKey].push(unquote(li[1]));
      continue;
    }

    if (!inBody) continue;

    const isItem = body === '-' || body.startsWith('- ');
    if (isItem && (itemIndent === -1 || indent === itemIndent)) {
      itemIndent = indent;
      item = { line: n, type: null, label: null };
      items.push(item);
      nest = null;
      const rest = body.slice(1).trim();
      if (rest) readItemKey(rest, indent + 2);
      continue;
    }
    if (!item) continue;
    readItemKey(body, indent);

    function readItemKey(kvText, at) {
      const kv = kvText.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/);
      if (!kv) return;
      const [, key, value = ''] = kv;
      if (isBlockScalar(value)) {
        skipDeeperThan = at;
        return;
      }
      if (nest && at > nestIndent) {
        if (nest === 'attributes' && key === 'label') item.label = unquote(value);
        return;
      }
      // Back at the item's own level.
      nest = value === '' ? key : null;
      nestIndent = at;
      if (key === 'type' && value !== '') item.type = unquote(value);
    }
  }

  return { ok: true, top, items };
}

// --- frontmatter and markdown ------------------------------------------------------

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * YAML frontmatter, when there is one, and the body after it.
 *
 * Re-homed from the installer's agent reader so the payload has one
 * frontmatter parser. `labels:` may be csv, `[a, b]`, or a block list.
 *
 * `raw` is the block's text, or null when there was none — for a caller that
 * wants to be stricter than this reader about what it accepts.
 *
 * @returns {{fields: object, body: string, raw: ?string}}
 */
export function parseFrontmatter(text) {
  const m = String(text ?? '').match(FRONTMATTER);
  if (!m) return { fields: {}, body: String(text ?? ''), raw: null };
  const walked = walkYaml(m[1]);
  const fields = { ...walked.top };
  if (fields.labels !== undefined && !Array.isArray(fields.labels)) fields.labels = splitList(fields.labels);
  return { fields, body: m[2].replace(/^(\r?\n)+/, ''), raw: m[1] };
}

/**
 * Every heading in a markdown document, fenced code excluded.
 *
 * @returns {Array<{level: number, text: string, line: number}>}
 */
export function headingsOf(markdown) {
  const out = [];
  let fence = null;
  const lines = String(markdown ?? '').split(/\r?\n/);
  for (let n = 1; n <= lines.length; n += 1) {
    const line = lines[n - 1];
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) out.push({ level: h[1].length, text: h[2].trim(), line: n });
  }
  return out;
}

const stem = (filename) => String(filename).replace(/^.*\//, '').replace(/\.[^.]+$/, '');

/** A markdown template: frontmatter fields plus the body's `##`/`###` headings. */
export function parseMarkdownTemplate(filename, text) {
  const { fields, body } = parseFrontmatter(text);
  return {
    ok: true,
    template: {
      name: fields.name || stem(filename),
      filename,
      title: fields.title ?? '',
      labels: Array.isArray(fields.labels) ? fields.labels : [],
      about: fields.about ?? '',
      sections: headingsOf(body)
        .filter((h) => h.level === 2 || h.level === 3)
        .map((h) => h.text),
      format: 'markdown',
      text: String(text ?? ''),
    },
  };
}

/** An issue form: top-level fields plus every non-`markdown` body item's label. */
export function parseIssueForm(filename, text) {
  const walked = walkYaml(text);
  if (!walked.ok) return walked;
  const sections = [];
  for (const item of walked.items) {
    if (!item.type) {
      return { ok: false, error: `${filename}, line ${item.line}: a body item needs a "type" — without it a section cannot be told from a markdown note` };
    }
    if (item.type === 'markdown') continue;
    if (item.label) sections.push(item.label);
  }
  const t = walked.top;
  return {
    ok: true,
    template: {
      name: t.name || stem(filename),
      filename,
      title: t.title ?? '',
      labels: Array.isArray(t.labels) ? t.labels : splitList(t.labels),
      about: t.description ?? t.about ?? '',
      sections,
      format: 'form',
      text: String(text ?? ''),
    },
  };
}

/** By extension: `.md` is markdown, `.yml`/`.yaml` an issue form. */
export function parseTemplate(filename, text) {
  const f = String(filename);
  if (/\.md$/i.test(f)) return parseMarkdownTemplate(f, text);
  if (/\.ya?ml$/i.test(f)) return parseIssueForm(f, text);
  return { ok: false, error: `${f}: not an issue template — expected .md, .yml or .yaml` };
}

const isTemplateFile = (name) => /\.(md|ya?ml)$/i.test(name) && !/^config\.ya?ml$/i.test(name);

// --- discovery ---------------------------------------------------------------------

/**
 * The raw template files in a checkout, in the order GitHub would offer them:
 * the directory sorted by name (`config.yml` is the chooser's config, not a
 * template), or — only when the directory has none — the legacy single files.
 *
 * @returns {Array<{filename: string, text: string}>}
 */
export function discoverLocal(root) {
  const dir = join(root, TEMPLATE_DIR);
  const out = [];
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    for (const name of readdirSync(dir).filter(isTemplateFile).sort()) {
      const p = join(dir, name);
      if (statSync(p).isFile()) out.push({ filename: name, text: readFileSync(p, 'utf8') });
    }
  }
  if (out.length) return out;
  for (const rel of LEGACY_TEMPLATE_FILES) {
    const p = join(root, rel);
    if (existsSync(p) && statSync(p).isFile()) out.push({ filename: rel, text: readFileSync(p, 'utf8') });
  }
  return out;
}

const parseAll = (files) => {
  const templates = [];
  for (const f of files) {
    if (!isTemplateFile(f.filename.replace(/^.*\//, ''))) continue;
    const r = parseTemplate(f.filename, f.text);
    if (!r.ok) return r;
    templates.push(r.template);
  }
  return { ok: true, templates };
};

/**
 * The repo's templates and where they came from: `checkout`, `api`, or `none`.
 *
 * The API is asked only when the checkout has none and the backend declares
 * `capabilities.issueTemplates` — a capability, never a provider name.
 *
 * @returns {Promise<{ok: true, templates: object[], source: 'checkout'|'api'|'none'} | {ok: false, error: string}>}
 */
export async function discoverTemplates({ root, provider }) {
  const local = parseAll(discoverLocal(root));
  if (!local.ok) return local;
  if (local.templates.length) return { ok: true, templates: local.templates, source: 'checkout' };

  if (!provider?.capabilities?.issueTemplates) return { ok: true, templates: [], source: 'none' };

  const r = await provider.templates();
  if (!r.ok) return { ok: false, error: `could not read the repository's issue templates: ${r.error}` };
  const remote = parseAll(r.data ?? []);
  if (!remote.ok) return remote;
  return remote.templates.length
    ? { ok: true, templates: remote.templates, source: 'api' }
    : { ok: true, templates: [], source: 'none' };
}

// --- selection ---------------------------------------------------------------------

const listNames = (templates) => templates.map((t) => `${t.filename} (${t.name})`).join(', ');

/**
 * Which template governs this create.
 *
 * With repo templates: exactly one needs no name; several need `--template`;
 * a name matches a filename or a template's `name`. With none: the shipped
 * default for `type`, and a `--template` is refused rather than silently
 * ignored — there is nothing for it to name.
 *
 * @returns {{ok: true, template: object, source: 'checkout'|'api'|'default'} | {ok: false, error: string}}
 */
export function selectTemplate({ templates = [], source = 'none', name, type } = {}) {
  if (templates.length) {
    if (name !== undefined) {
      const want = String(name).trim().toLowerCase();
      const hit = templates.find(
        (t) => t.filename.toLowerCase() === want || stem(t.filename).toLowerCase() === want || t.name.toLowerCase() === want,
      );
      if (!hit) return { ok: false, error: `no issue template named "${name}" — the repository has: ${listNames(templates)}` };
      return { ok: true, template: hit, source };
    }
    if (templates.length === 1) return { ok: true, template: templates[0], source };
    return {
      ok: false,
      error: `the repository has ${templates.length} issue templates and one must be named — pass --template <name>: ${listNames(templates)}`,
    };
  }
  if (name !== undefined) {
    return { ok: false, error: `the repository has no issue templates for --template "${name}" to name — the shipped default for the type applies without it` };
  }
  return { ok: true, template: defaultTemplateFor(type), source: 'default' };
}

/** The provenance line `create` prints on stderr, so the source is never ambiguous. */
export function describeSource(source, template, type) {
  if (source === 'checkout') return 'repo checkout';
  if (source === 'api') return 'repo via API';
  return `shipped default for ${type ?? template?.name ?? 'generic'}`;
}

// --- validation --------------------------------------------------------------------

/** The body split at its headings: which sections it has, and what is under each. */
function sectionsOf(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  const heads = headingsOf(body);
  return heads.map((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].line - 1 : lines.length;
    return { heading: h.text, content: lines.slice(h.line, end).join('\n').trim() };
  });
}

/**
 * Does `body` satisfy `template`?
 *
 * `missing` are the sections that make this a refusal; `warnings` are what
 * the caller prints and files anyway. Extra sections never fail.
 *
 * @param {string} body
 * @param {object} template
 * @param {{source: 'checkout'|'api'|'default'}} opts
 * @returns {{ok: boolean, missing: string[], warnings: string[]}}
 */
export function validateBody(body, template, { source = 'default' } = {}) {
  const have = sectionsOf(body);
  const find = (heading) => have.find((s) => norm(s.heading) === norm(heading));
  const missing = [];
  const warnings = [];

  if (source === 'default') {
    for (const s of template.sections) {
      const got = find(s);
      if (isCriteria(s)) {
        if (!got || !got.content) missing.push(s);
      } else if (!got) {
        warnings.push(`section "## ${s}" is missing — the shipped ${template.name} template has it; filed without it`);
      }
    }
    return { ok: missing.length === 0, missing, warnings };
  }

  for (const s of template.sections) if (!find(s)) missing.push(s);
  if (!template.sections.some(isCriteria)) {
    warnings.push(
      `template "${template.name}" has no acceptance criteria section — /dev-tdd and /dev-done verify against a criteria list this project's template does not ask for`,
    );
  }
  return { ok: missing.length === 0, missing, warnings };
}

// --- rendering and applying --------------------------------------------------------

/** A repo template verbatim; a shipped default as its skeleton. */
export function renderTemplate(template) {
  return template.text;
}

/**
 * What the template adds to a create: its `title:` as a prefix on the summary
 * (once — re-applying to an already-prefixed summary changes nothing) and its
 * `labels:`, applied by the caller on top of the type label.
 *
 * @returns {{summary: string, labels: string[]}}
 */
export function applyTemplate(template, summary) {
  const prefix = String(template.title ?? '').trim();
  const s = String(summary ?? '').trim();
  const prefixed = prefix && !s.toLowerCase().startsWith(prefix.toLowerCase()) ? `${prefix} ${s}` : s;
  return { summary: prefixed, labels: [...(template.labels ?? [])] };
}
