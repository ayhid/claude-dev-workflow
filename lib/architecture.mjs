/**
 * The target architecture: the set of documents a project should end up with,
 * read from a file the user wrote. No IO — the caller reads the file and says
 * which format it is, from the extension.
 *
 * ## Why the YAML parser is this small
 *
 * `lib/` has no dependencies and may not grow one, so there is no YAML
 * library to reach for. Rather than a general parser, this reads exactly one
 * shape — a top-level `sections:` list of flat `id`/`title`/`description`
 * mappings, the shape the JSON form has — and refuses everything else by line
 * number. A nested mapping, a block scalar, an inline `{...}`, an anchor, a
 * tab: each is a refusal naming the line, never a guess at what was meant.
 * The refusals are the design. A parser that is usually right mis-reads the
 * one file it cannot handle silently, and the mapping built on it is wrong in
 * a way nobody can see.
 */

/** The keys a section may carry, and every one of them is required. */
const SECTION_KEYS = ['id', 'title', 'description'];

/** An id doubles as a file stem (`<id>.md`), so it has to be safe as one. */
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * @param {string} text
 * @param {{format: 'json'|'yaml'}} opts
 * @returns {{ok: true, sections: Array<{id: string, title: string, description: string}>} | {ok: false, error: string}}
 */
export function parseArchitecture(text, { format } = {}) {
  let raw;
  if (format === 'json') {
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return { ok: false, error: `the architecture file is not valid JSON: ${err.message}` };
    }
  } else if (format === 'yaml') {
    const parsed = parseYamlSubset(text);
    if (!parsed.ok) return parsed;
    raw = parsed.value;
  } else {
    return { ok: false, error: `architecture format must be json or yaml (from the file's extension), not "${format}"` };
  }
  return validateSections(raw);
}

function validateSections(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !Array.isArray(raw.sections)) {
    return { ok: false, error: 'the architecture must be an object with a "sections" list' };
  }
  const extra = Object.keys(raw).filter((k) => k !== 'sections');
  if (extra.length) return { ok: false, error: `unknown top-level key(s): ${extra.join(', ')} — only "sections" is read` };
  if (!raw.sections.length) return { ok: false, error: 'the architecture names no sections' };

  const sections = [];
  const seen = new Set();
  for (const [i, s] of raw.sections.entries()) {
    const at = `section ${i + 1}`;
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return { ok: false, error: `${at}: must be a mapping of id, title, description` };
    const unknown = Object.keys(s).filter((k) => !SECTION_KEYS.includes(k));
    if (unknown.length) return { ok: false, error: `${at}: unknown key(s) ${unknown.join(', ')} — a section has ${SECTION_KEYS.join(', ')}` };

    const id = String(s.id ?? '').trim();
    if (!id) return { ok: false, error: `${at}: needs an id — it names the file (<id>.md)` };
    if (!SAFE_ID.test(id)) return { ok: false, error: `${at}: id "${id}" is not a safe file stem (letters, digits, . _ -)` };
    // Compared case-insensitively: the id is a file stem, and on a
    // case-insensitive file system `Architecture.md` and `architecture.md`
    // are one file, so two such sections would overwrite each other silently.
    if (seen.has(id.toLowerCase())) return { ok: false, error: `${at}: id "${id}" is already used by another section (ids are compared ignoring case — they name files)` };
    seen.add(id.toLowerCase());

    const title = String(s.title ?? '').trim();
    if (!title) return { ok: false, error: `${at} (${id}): needs a title` };
    const description = String(s.description ?? '').trim();
    if (!description) return { ok: false, error: `${at} (${id}): needs a description — what belongs in it` };

    sections.push({ id, title, description });
  }
  return { ok: true, sections };
}

/**
 * The YAML subset. One pass over the lines, tracking only whether we are
 * inside `sections:` and inside a list item; anything that does not fit the
 * grammar below is a refusal with its line number.
 *
 *   sections:
 *     - id: x            # or "-" alone, keys on the following lines
 *       title: "Quoted"  # or bare; a trailing "# comment" is dropped
 *       description: d
 */
function parseYamlSubset(text) {
  const lines = text.split(/\r?\n/);
  const value = {};
  let sections = null;
  let current = null;
  let itemIndent = -1;
  let fieldIndent = -1;

  const refuse = (n, why) => ({ ok: false, error: `architecture file, line ${n}: ${why}` });

  for (let n = 1; n <= lines.length; n++) {
    const line = lines[n - 1];
    if (/\t/.test(line)) return refuse(n, 'tabs are not accepted — indent with spaces');
    const stripped = stripComment(line);
    if (!stripped.trim()) continue;

    const indent = stripped.match(/^ */)[0].length;
    const body = stripped.trim();

    if (indent === 0) {
      if (body === 'sections:') {
        if (sections) return refuse(n, '"sections" appears twice');
        sections = [];
        value.sections = sections;
        current = null;
        continue;
      }
      return refuse(n, `only a top-level "sections:" list is read, not "${body}"`);
    }

    if (!sections) return refuse(n, 'content before "sections:"');

    if (body.startsWith('- ') || body === '-') {
      // Every item sits at the indentation of the first one. A "-" deeper
      // than that is a nested list, which this shape has no place for; one
      // shallower is a different list. Either is refused, never read as a
      // sibling section.
      if (itemIndent !== -1 && indent !== itemIndent) {
        return refuse(n, `a list item must be indented like the first one (${itemIndent} spaces) — nested lists are not accepted`);
      }
      const rest = body.slice(1).trim();
      current = {};
      sections.push(current);
      itemIndent = indent;
      fieldIndent = -1;
      if (!rest) continue;
      const kv = readKeyValue(rest, n);
      if (!kv.ok) return kv;
      current[kv.key] = kv.value;
      continue;
    }

    if (!current) return refuse(n, 'expected a list item ("- id: …") under "sections:"');
    if (indent <= itemIndent) return refuse(n, 'a section key must be indented deeper than its "-"');
    if (fieldIndent === -1) fieldIndent = indent;
    else if (indent !== fieldIndent) return refuse(n, `a section key must be indented like the others in its section (${fieldIndent} spaces)`);
    const kv = readKeyValue(body, n);
    if (!kv.ok) return kv;
    if (kv.key in current) return refuse(n, `"${kv.key}" appears twice in one section`);
    current[kv.key] = kv.value;
  }

  if (!sections) return { ok: false, error: 'the architecture file has no "sections:" list' };
  return { ok: true, value };

  function readKeyValue(body, n) {
    const m = body.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/);
    if (!m) {
      if (body.startsWith('{') || body.startsWith('[')) return refuse(n, 'inline {…} and […] are not accepted — one key per line');
      return refuse(n, `expected "key: value", got "${body}"`);
    }
    const [, key, rawValue = ''] = m;
    if (!SECTION_KEYS.includes(key)) return refuse(n, `unknown key "${key}" — a section has ${SECTION_KEYS.join(', ')}`);
    const v = rawValue.trim();
    if (!v) return refuse(n, `"${key}" has no value on its line — nested or block values are not accepted`);
    if (v === '|' || v === '>' || v.startsWith('|') || v.startsWith('>')) return refuse(n, `"${key}" uses a block scalar — write the value on one line`);
    if (v.startsWith('{') || v.startsWith('[')) return refuse(n, `"${key}" is a mapping or list — only a plain string is accepted`);
    if (v.startsWith('&') || v.startsWith('*') || v.startsWith('!')) return refuse(n, `"${key}" uses an anchor, alias or tag — not accepted`);
    if (v.startsWith('"') || v.startsWith("'")) {
      if (v.length < 2 || !v.endsWith(v[0])) return refuse(n, `"${key}" has an unterminated quote`);
      return { ok: true, key, value: v.slice(1, -1) };
    }
    return { ok: true, key, value: v };
  }
}

/**
 * Drop a trailing ` # comment`, but not a `#` inside quotes. A quote only
 * opens at the start of a token — after whitespace or a `:` — so the
 * apostrophe in `Don't` is a letter, not a delimiter.
 */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s:]/.test(line[i - 1]))) {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}
