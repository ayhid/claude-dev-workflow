#!/usr/bin/env node
/**
 * Interactive installer for the youtrack-workflow Claude Code plugin.
 *
 *   npx youtrack-workflow            # configure the project in the cwd
 *   npx youtrack-workflow --dir ..   # …somewhere else
 *   npx youtrack-workflow --print    # show the config, write nothing
 *
 * Two things happen here: `.youtrack.json` is written for the target project,
 * and the plugin itself is registered with Claude Code. Both are optional and
 * either can be skipped.
 */
import { execFileSync, execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import * as p from '@clack/prompts';
import c from 'picocolors';

import { listProjects, projectFieldValues, whoami } from '../lib/youtrack.mjs';
import { baseBranch, commitIdPosition, describeRepo, findRepos } from './lib/detect.mjs';

const execFileAsync = promisify(execFile);
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where Claude Code should be pointed at for the marketplace.
 *
 * Under `npx`, PLUGIN_ROOT sits in a cache directory npm is free to delete, so
 * a marketplace registered from there breaks on the next cache prune. Fall back
 * to the canonical repo whenever this copy looks ephemeral.
 */
const repoUrl = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'));
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    if (url) return url.replace(/^git\+/, '').replace(/\.git$/, '');
  } catch {
    /* fall through */
  }
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: PLUGIN_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .replace(/\.git$/, '');
  } catch {
    return null;
  }
})();

const isEphemeral = /[/\\](_npx|node_modules)[/\\]/.test(PLUGIN_ROOT);
// A local checkout is the better source when there is one — it is what the user
// can edit. Only reach for the remote when this copy will not survive.
const MARKETPLACE_SOURCE = isEphemeral && repoUrl ? repoUrl : PLUGIN_ROOT;

// --- argv --------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (flag('--help') || flag('-h')) {
  console.log(`
${c.bold('youtrack-workflow')} — set up the YouTrack ticket workflow for a project

  --dir <path>   target project directory (default: cwd)
  --print        print the resulting config instead of writing it
  --force        overwrite an existing .youtrack.json without asking
  --help         this message
`);
  process.exit(0);
}

const targetDir = resolve(opt('--dir', process.cwd()));
const configPath = join(targetDir, '.youtrack.json');

// --- helpers -----------------------------------------------------------------
const bail = (value) => {
  if (p.isCancel(value)) {
    p.cancel('Cancelled — nothing was written.');
    process.exit(0);
  }
  return value;
};

const has = (bin) => {
  try {
    execFileSync('command', ['-v', bin], { stdio: 'ignore', shell: '/bin/bash' });
    return true;
  } catch {
    return false;
  }
};

/**
 * Install the runtime dependencies into the *installed* plugin directory.
 *
 * Claude Code clones a plugin and never runs `npm install`, so `scripts/` would
 * start with no `node_modules`. The install lands in the version-scoped cache
 * directory Claude Code recorded — not PLUGIN_ROOT, which under npx is a cache
 * npm may prune. An upgrade creates a new such directory, empty again; that
 * case is handled at runtime by scripts/bootstrap.mjs.
 */
async function installPluginDeps() {
  const registry = join(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    'plugins',
    'installed_plugins.json',
  );
  if (!existsSync(registry)) return;

  let installPath;
  try {
    const data = JSON.parse(readFileSync(registry, 'utf8'));
    const entries = data?.plugins?.['youtrack-workflow@youtrack-workflow-marketplace'] ?? [];
    installPath = entries.at(-1)?.installPath;
  } catch {
    return;
  }
  if (!installPath || !existsSync(join(installPath, 'package.json'))) return;

  await execFileAsync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefix', installPath], {
    timeout: 120_000,
  });
}

/** Read a secret out of 1Password without it ever touching the terminal. */
async function opRead(ref) {
  try {
    const { stdout } = await execFileAsync('op', ['read', ref], { timeout: 30_000 });
    return stdout.trim();
  } catch (err) {
    return { error: err.stderr?.trim() || err.message };
  }
}

// --- go ----------------------------------------------------------------------
p.intro(`${c.bgCyan(c.black(' youtrack-workflow '))}  ${c.dim(targetDir)}`);

if (!existsSync(targetDir)) {
  p.cancel(`No such directory: ${targetDir}`);
  process.exit(1);
}

let existing = null;
if (existsSync(configPath) && !flag('--print')) {
  try {
    existing = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    p.log.warn(`${c.yellow('.youtrack.json exists but is not valid JSON')} — it will be replaced.`);
  }
  if (existing && !flag('--force')) {
    p.log.info(
      `Found an existing config: ${c.cyan(existing.project ?? '?')} on ${c.cyan(existing.baseUrl ?? '?')}`,
    );
    const go = bail(
      await p.confirm({ message: 'Reconfigure it? Current values become the defaults.', initialValue: true }),
    );
    if (!go) {
      p.outro('Left untouched.');
      process.exit(0);
    }
  }
}

// --- 1. instance -------------------------------------------------------------
const baseUrl = bail(
  await p.text({
    message: 'YouTrack instance URL',
    placeholder: 'https://acme.youtrack.cloud',
    initialValue: existing?.baseUrl ?? process.env.YOUTRACK_BASE_URL ?? '',
    validate: (v) => {
      if (!v) return 'Required.';
      try {
        const u = new URL(v);
        if (!/^https?:$/.test(u.protocol)) return 'Must be an http(s) URL.';
      } catch {
        return 'Not a valid URL.';
      }
    },
  }),
).replace(/\/+$/, '');

// --- 2. token ----------------------------------------------------------------
const hasOp = has('op');
const tokenChoice = bail(
  await p.select({
    message: 'Where should the token come from?',
    initialValue: existing?.tokenOpRef ? '1password' : process.env.YOUTRACK_TOKEN ? 'env' : hasOp ? '1password' : 'env',
    options: [
      {
        value: '1password',
        label: '1Password reference',
        hint: hasOp ? 'op://Vault/item/credential — nothing stored on disk' : '`op` CLI not found on PATH',
      },
      {
        value: 'env',
        label: '$YOUTRACK_TOKEN',
        hint: process.env.YOUTRACK_TOKEN ? 'detected in this shell' : 'you export it yourself',
      },
    ],
  }),
);

let tokenOpRef = null;
let token = process.env.YOUTRACK_TOKEN ?? '';

if (tokenChoice === '1password') {
  tokenOpRef = bail(
    await p.text({
      message: '1Password secret reference',
      placeholder: 'op://Private/youtrack/credential',
      initialValue: existing?.tokenOpRef ?? process.env.YOUTRACK_TOKEN_OP_REF ?? '',
      validate: (v) => (v?.startsWith('op://') ? undefined : 'Must start with op://'),
    }),
  );
  if (hasOp) {
    const s = p.spinner();
    s.start('Reading the token from 1Password');
    const result = await opRead(tokenOpRef);
    if (typeof result === 'string' && result) {
      token = result;
      s.stop('Token read from 1Password.');
    } else {
      s.stop(c.yellow('Could not read it — is your 1Password session unlocked?'));
      p.log.warn(result?.error ?? 'op returned nothing');
    }
  }
} else if (!token) {
  token = bail(
    await p.password({
      message: 'Paste a YouTrack token (used only to verify — never written to disk)',
      validate: (v) => (v ? undefined : 'Required, or Ctrl-C to abort.'),
    }),
  );
}

// --- 3. verify, and use the live instance to fill in the rest -----------------
let online = false;
let projects = [];

if (token) {
  const s = p.spinner();
  s.start(`Verifying against ${baseUrl}`);
  const me = await whoami(baseUrl, token);
  if (me.ok) {
    const list = await listProjects(baseUrl, token);
    if (list.ok) {
      projects = (list.data ?? []).filter((x) => x.shortName);
      online = true;
      s.stop(`Authenticated as ${c.green(me.data)} — ${projects.length} project(s) visible.`);
    } else {
      s.stop(c.yellow(`Authenticated, but the project list failed: ${list.error}`));
    }
  } else {
    s.stop(c.yellow(`Could not authenticate: ${me.error}`));
  }
} else {
  p.log.warn('No token available — continuing offline; values will be typed by hand.');
}

if (!online) {
  const go = bail(
    await p.confirm({
      message: 'Continue without the API? States and project key will not be validated.',
      initialValue: true,
    }),
  );
  if (!go) {
    p.cancel('Aborted — fix the token and run again.');
    process.exit(1);
  }
}

// --- 4. project --------------------------------------------------------------
let project;
let projectId = null;

if (online && projects.length) {
  const sorted = projects.slice().sort((a, b) => a.shortName.localeCompare(b.shortName));
  project = bail(
    await p.select({
      message: 'Which project?',
      initialValue: sorted.find((x) => x.shortName === existing?.project)?.shortName ?? sorted[0].shortName,
      options: sorted.map((x) => ({ value: x.shortName, label: x.shortName, hint: x.name })),
      maxItems: 12,
    }),
  );
  projectId = projects.find((x) => x.shortName === project)?.id ?? null;
} else {
  project = bail(
    await p.text({
      message: 'Project key (the prefix in issue IDs, e.g. ABC)',
      initialValue: existing?.project ?? '',
      validate: (v) => (/^[A-Za-z][A-Za-z0-9]*$/.test(v ?? '') ? undefined : 'Letters and digits, starting with a letter.'),
    }),
  );
}

// --- 5. states, from the project's real field values -------------------------
let stateValues = [];
let typeValues = existing?.issueTypes ?? ['Bug', 'Feature', 'Task', 'Epic', 'Improvement'];
let priorityValues = existing?.priorities ?? ['Show-stopper', 'Critical', 'Major', 'Normal', 'Minor'];

if (online && projectId) {
  const s = p.spinner();
  s.start(`Reading the field values of ${project}`);
  const fields = await projectFieldValues(baseUrl, token, projectId);
  if (fields.ok) {
    stateValues = (fields.data.State ?? []).map((v) => v.name);
    if (fields.data.Type?.length) typeValues = fields.data.Type.map((v) => v.name);
    if (fields.data.Priority?.length) priorityValues = fields.data.Priority.map((v) => v.name);
    s.stop(
      stateValues.length
        ? `States: ${c.dim(stateValues.join(' → '))}`
        : c.yellow('No State field found — you will type the state names.'),
    );
  } else {
    s.stop(c.yellow(`Could not read the field values: ${fields.error}`));
  }
}

const pickState = async (message, hint, fallback) => {
  if (stateValues.length) {
    const guess = stateValues.find((s) => s.toLowerCase() === String(fallback).toLowerCase());
    return bail(
      await p.select({
        message: `${message} ${c.dim(`(${hint})`)}`,
        initialValue: guess ?? fallback,
        options: stateValues.map((s) => ({ value: s, label: s })),
        maxItems: 12,
      }),
    );
  }
  return bail(await p.text({ message: `${message} ${c.dim(`(${hint})`)}`, initialValue: fallback }));
};

const states = {
  start: await pickState('State meaning "started"', '/task moves here', existing?.states?.start ?? 'In Progress'),
  review: await pickState('State meaning "in review"', 'set when a PR opens', existing?.states?.review ?? 'In Review'),
  done: await pickState('State meaning "finished"', '/done moves here', existing?.states?.done ?? 'Done'),
  ladder: stateValues.length ? stateValues : (existing?.states?.ladder ?? []),
};

// --- 6. ticket language ------------------------------------------------------
const commonLanguages = ['English', 'French', 'German', 'Spanish', 'Italian', 'Portuguese', 'Dutch'];
let language = bail(
  await p.select({
    message: `Language for ticket prose ${c.dim('(often not the language you talk to Claude in)')}`,
    initialValue: commonLanguages.includes(existing?.language) ? existing.language : 'English',
    options: [...commonLanguages.map((l) => ({ value: l, label: l })), { value: '__other', label: 'Something else…' }],
  }),
);
if (language === '__other') {
  language = bail(
    await p.text({ message: 'Language name', initialValue: existing?.language ?? '', validate: (v) => (v ? undefined : 'Required.') }),
  );
}

// --- 7. repos ----------------------------------------------------------------
const candidates = findRepos(targetDir).map(describeRepo);
let repos = [];

if (candidates.length) {
  // Prefer the directories that actually have something to run. A workspace
  // root that only wraps its children, and a docs-only sibling, are git repos
  // too — offer them, but do not tick them by default.
  const withChecks = candidates.filter((r) => r.checks.length);
  const preselected = existing?.repos?.length
    ? candidates.filter((r) => existing.repos.some((e) => e.path === r.path)).map((r) => r.path)
    : withChecks.length
      ? withChecks.map((r) => r.path)
      : candidates.filter((r) => r.packageManager || r.isGitRepo).map((r) => r.path);

  const chosen = bail(
    await p.multiselect({
      message: `Which directories hold code Claude will work in? ${c.dim('(space to toggle)')}`,
      required: false,
      initialValues: preselected.length ? preselected : [candidates[0].path],
      options: candidates.map((r) => ({
        value: r.path,
        label: r.path === '.' ? `${r.path}  ${c.dim('(project root)')}` : r.path,
        hint:
          [
            r.isGitRepo ? 'git repo' : null,
            r.packageManager,
            r.checks.length ? `${r.checks.length} check(s)` : null,
          ]
            .filter(Boolean)
            .join(', ') || 'no markers found',
      })),
    }),
  );

  for (const path of chosen) {
    const found = candidates.find((r) => r.path === path);
    const prior = existing?.repos?.find((e) => e.path === path);

    const checksDefault = (prior?.checks ?? found.checks).join(' && ');
    const checksAnswer = bail(
      await p.text({
        message: `Checks for ${c.cyan(path)} ${c.dim('(&&-separated; blank for none)')}`,
        initialValue: checksDefault,
        defaultValue: '',
      }),
    );
    const checks = checksAnswer.split('&&').map((s) => s.trim()).filter(Boolean);

    const when = bail(
      await p.text({
        message: `What belongs in ${c.cyan(path)}? ${c.dim('(routing hint; blank if it is the only one)')}`,
        initialValue: prior?.when ?? '',
        defaultValue: '',
      }),
    );

    const entry = { path };
    if (when) entry.when = when;
    if (checks.length) entry.checks = checks;
    const env = { ...(prior?.env ?? {}), ...found.env };
    if (Object.keys(env).length) entry.env = env;
    const remotes = prior?.remotes ?? found.remotes;
    if (remotes.length > 1) entry.remotes = remotes;
    const scopes = prior?.scopes ?? found.scopes;
    if (scopes?.length) entry.scopes = scopes;
    repos.push(entry);
  }
}

// --- 8. commit convention ----------------------------------------------------
const rootRepo = candidates.find((r) => r.path === '.') ?? candidates[0];
const detectedTypes = candidates.map((r) => r.types).find((t) => t?.length);
const conventionSource = candidates.find((r) => r.types?.length)?.conventionSource;
const detectedPosition = rootRepo ? commitIdPosition(rootRepo.dir) : null;

if (conventionSource) {
  p.log.success(`Commit types read from ${c.cyan(conventionSource)}: ${c.dim(detectedTypes.join(', '))}`);
}
if (detectedPosition) {
  p.log.info(`Recent commits put the issue ID at the ${c.cyan(detectedPosition)} of the subject.`);
}

const position = bail(
  await p.select({
    message: 'Where does the issue ID go in a commit subject?',
    initialValue: existing?.commit?.position ?? detectedPosition ?? 'suffix',
    options: [
      { value: 'suffix', label: 'Suffix', hint: 'feat(api): add thing (ABC-123)  — commitlint-safe' },
      { value: 'prefix', label: 'Prefix', hint: 'ABC-123 feat(api): add thing' },
      { value: 'any', label: 'Anywhere', hint: 'only require that an ID appears' },
    ],
  }),
);

const requireType = bail(
  await p.confirm({
    message: 'Does this project use conventional commits (feat:, fix: …)?',
    initialValue: existing?.commit?.requireType !== false && Boolean(detectedTypes ?? true),
  }),
);

const enforce = bail(
  await p.confirm({
    message: `Block commits that do not follow this? ${c.dim('(a PreToolUse hook; escape hatch stays available)')}`,
    initialValue: existing?.commit?.enforce !== false,
  }),
);

// --- 9. reviewer -------------------------------------------------------------
const reviewer = bail(
  await p.text({
    message: `Default PR reviewer ${c.dim('(blank for none)')}`,
    initialValue: existing?.reviewer ?? '',
    defaultValue: '',
  }),
);

// --- 10. assemble ------------------------------------------------------------
const idPattern = position === 'prefix' ? '<ID> type(scope): description' : 'type(scope): description (<ID>)';

const config = {
  baseUrl,
  project,
  ...(projectId ? { projectId } : {}),
  ...(tokenOpRef ? { tokenOpRef } : {}),
  language,
  states,
  branch: {
    pattern: existing?.branch?.pattern ?? '<ID>-<slug>',
    base: existing?.branch?.base ?? (rootRepo ? baseBranch(rootRepo.dir) : 'main'),
  },
  commit: {
    pattern: requireType ? idPattern : position === 'prefix' ? '<ID>: description' : 'description (<ID>)',
    position,
    noTicketEscape: existing?.commit?.noTicketEscape ?? 'chore(no-ticket)',
    ...(detectedTypes?.length ? { types: detectedTypes } : {}),
    ...(requireType ? {} : { requireType: false }),
    ...(enforce ? {} : { enforce: false }),
  },
  issueTypes: typeValues,
  priorities: priorityValues,
  defaultPriority: priorityValues.includes(existing?.defaultPriority)
    ? existing.defaultPriority
    : (priorityValues.find((v) => /normal|medium/i.test(v)) ?? priorityValues[Math.floor(priorityValues.length / 2)] ?? 'Normal'),
  ...(reviewer ? { reviewer } : {}),
  ...(repos.length ? { repos } : {}),
  ...(existing?.notes ? { notes: existing.notes } : {}),
};

const json = JSON.stringify(config, null, 2) + '\n';

p.note(json.trimEnd(), `${configPath}`);

if (flag('--print')) {
  p.outro('Printed only — nothing written.');
  process.exit(0);
}

const write = bail(await p.confirm({ message: `Write ${c.cyan('.youtrack.json')}?`, initialValue: true }));
if (write) {
  writeFileSync(configPath, json, 'utf8');
  p.log.success(`Wrote ${configPath}`);
  p.log.info(
    `It holds no secret${tokenOpRef ? ' — tokenOpRef is a 1Password reference, not a token' : ''}, so it is safe to commit.`,
  );
} else {
  p.log.warn('Skipped — no config written.');
}

// --- 11. register the plugin with Claude Code --------------------------------
const claudeAvailable = has('claude');
if (claudeAvailable) {
  const install = bail(
    await p.confirm({
      message: 'Register the youtrack-workflow plugin with Claude Code now?',
      initialValue: true,
    }),
  );

  if (install) {
    const s = p.spinner();
    s.start('Adding the marketplace and installing');
    try {
      await execFileAsync('claude', ['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE], { timeout: 60_000 });
      await execFileAsync('claude', ['plugin', 'install', 'youtrack-workflow@youtrack-workflow-marketplace'], {
        timeout: 60_000,
      });
      s.stop('Plugin installed.');

      // Claude Code clones the plugin and never runs `npm install`, so the
      // runtime scripts would have no dependencies. scripts/bootstrap.mjs can
      // heal that on first use, but doing it here means the first /task does
      // not pause for an install.
      await installPluginDeps();
    } catch (err) {
      s.stop(c.yellow('Could not install automatically.'));
      p.log.warn((err.stderr || err.message || '').trim().slice(0, 400));
      p.note(
        [`/plugin marketplace add ${MARKETPLACE_SOURCE}`, '/plugin install youtrack-workflow@youtrack-workflow-marketplace'].join(
          '\n',
        ),
        'Run these in Claude Code instead',
      );
    }
  }
} else {
  p.note(
    [`/plugin marketplace add ${MARKETPLACE_SOURCE}`, '/plugin install youtrack-workflow@youtrack-workflow-marketplace'].join('\n'),
    'Then, in Claude Code',
  );
}

// --- done --------------------------------------------------------------------
const nextSteps = [
  `${c.cyan('/task ABC-123')}   start work on an issue`,
  `${c.cyan('/bug it broke')}   file one without losing your place`,
  `${c.cyan('/done')}           verify and close out`,
];
if (!tokenOpRef) {
  nextSteps.push('', c.dim('Remember to export $YOUTRACK_TOKEN in the shell Claude Code runs in.'));
}
p.note(nextSteps.join('\n'), 'Next');
p.outro(`${c.green('Ready.')} ${c.dim(`${project} on ${baseUrl}`)}`);
