/**
 * What an issue ID looks like, per backend.
 *
 * Three places need this and only one of them is JavaScript:
 *
 *   - `lib/sync.mjs` scans PR titles and branch names for IDs;
 *   - `scripts/cmd/*` validate and sort them;
 *   - `hooks/check-commit-ticket.sh` matches them in a commit subject, in bash.
 *
 * So each syntax carries **two** spellings of the same rule: a JS `RegExp`, and
 * an `ere` string for the shell. They are not interchangeable — bash `=~`,
 * `grep -E` and `sed -E` are POSIX ERE, which has no `\b`, no `\d` and no
 * lookaround. Writing the shell one as a PCRE is the mistake this file exists to
 * make impossible to repeat silently.
 *
 * `YouTrack` IDs are `PROJ-123` and globally unique. GitHub IDs are `#123` and
 * only unique *within a repository* — see the `issuesRepo` requirement in the
 * GitHub adapter.
 */

/**
 * @typedef {Object} IdSyntax
 * @property {string}  provider
 * @property {RegExp}  regex     global, for scanning free text
 * @property {string}  ere       POSIX ERE equivalent, for the bash hook
 * @property {string}  sample    shown in error messages
 * @property {(id: string) => number} numberOf
 * @property {(id: string) => string} canonical  the one spelling of an ID
 */

/** Escape a value for literal use inside a RegExp. */
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The GitHub ID spellings `canonical` will rewrite: `12`, `#12`, `acme/api#12`.
 *
 * Anchored at both ends on purpose. This is the one place that decides an
 * argument *is* an issue ID, and a pattern that merely finds a number inside a
 * string would accept every string that ends in one.
 */
const GITHUB_ID = /^(?:[\w.-]+\/[\w.-]+#|#)?(\d+)$/;

/** The YouTrack pattern used before this file existed, kept byte-identical. */
export const DEFAULT_YOUTRACK_ERE = '[A-Z][A-Z0-9]*-[0-9]+';

/**
 * The ID syntax implied by a config.
 *
 * @param {object} config
 * @returns {IdSyntax}
 */
export function idSyntaxFor(config) {
  const provider = config?.provider ?? 'youtrack';

  if (provider === 'github') {
    return {
      provider,
      // `owner/repo#12` and a bare `#12` both refer to an issue; the number is
      // what identifies it once the repo is pinned by config.
      regex: /(?:\b[\w.-]+\/[\w.-]+)?#(\d+)\b/g,
      ere: '#[0-9]+',
      sample: '#123',
      numberOf: (id) => Number(/(\d+)\s*$/.exec(String(id))?.[1] ?? 0),
      // `#12`, `12` and `acme/api#12` all name the same issue once the repo is
      // pinned by config, and the adapter accepts all three — so the spelling
      // that reaches the tracker, the branch, the printed line and the metrics
      // log has to be chosen here rather than by whoever typed it.
      //
      // Those three forms and nothing else. Reading the trailing digits out of
      // whatever arrived would canonicalise `ABC-37` — a YouTrack ID typed into
      // a GitHub project, which is exactly the kind of mistake a person makes —
      // into `#37`, and `start` would then move a real and unrelated issue with
      // no error anywhere. An unrecognised spelling is passed through untouched
      // so the adapter refuses it by name (provider rule 2: no inference).
      canonical: (id) => {
        const raw = String(id ?? '').trim();
        return GITHUB_ID.test(raw) ? `#${/(\d+)$/.exec(raw)[1]}` : raw;
      },
    };
  }

  // A project key narrows the scan so `ABD-1` is not picked up in an `ABC`
  // project. Escaped, because a key is user input that lands inside a RegExp.
  const key = config?.project;
  return {
    provider: 'youtrack',
    regex: key
      ? new RegExp(`\\b${escapeRe(key)}-\\d+\\b`, 'g')
      : new RegExp(`\\b${DEFAULT_YOUTRACK_ERE}\\b`.replace('[0-9]+', '\\d+'), 'g'),
    ere: DEFAULT_YOUTRACK_ERE,
    sample: key ? `${key}-123` : 'ABC-123',
    numberOf: (id) => Number(/(\d+)\s*$/.exec(String(id))?.[1] ?? 0),
    // `PROJ-123` has no optional sigil and no second legal spelling, so there is
    // nothing to normalise but the whitespace an argument list leaves behind.
    // Case is deliberately left alone: upper-casing would be a guess about a
    // project key we were given, which is the inference rule 2 forbids.
    canonical: (id) => String(id ?? '').trim(),
  };
}

/**
 * `id`, spelled the one way this project spells it.
 *
 * The convenience form of `idSyntaxFor(config).canonical`, because the callers
 * that need it — every command that reads an ID out of argv — want the string
 * and nothing else from the syntax.
 *
 * Applied once, where argv becomes an ID, so the tracker call, the branch name,
 * the printed output and the metrics log all see the same spelling. Normalising
 * further down instead — in the provider, or in the metrics wrapper — would fix
 * the log and leave the printed `issue:` line disagreeing with it (#43).
 *
 * @param {object} config
 * @param {string} id
 * @returns {string}
 */
export function canonicalId(config, id) {
  return idSyntaxFor(config).canonical(id);
}
