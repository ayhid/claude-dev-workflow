#!/usr/bin/env node
/**
 * Interactive installer for the dev-workflow Claude Code skills.
 *
 *   npx dev-workflow            # configure the project in the cwd
 *   npx dev-workflow --dir ..   # …somewhere else
 *   npx dev-workflow --print    # show the config, write nothing
 *
 * Two things happen here: `.dev-workflow.json` is written for the target project,
 * and the plugin itself is registered with Claude Code. Both are optional and
 * either can be skipped.
 */
import { execFileSync, execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import * as p from '@clack/prompts';
import c from 'picocolors';

import { listProjects, projectFieldValues, whoami } from '../lib/youtrack.mjs';
import { baseBranch, commitIdPosition, describeRepo, findRepos } from './lib/detect.mjs';
import { PAYLOAD_DIR, installPayload, readManifest } from './lib/payload.mjs';

const execFileAsync = promisify(execFile);
/** The distribution we copy out of — this checkout, or the npx cache. */
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The version recorded in the installed manifest. */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(SOURCE_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// --- argv --------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (flag('--help') || flag('-h')) {
  console.log(`
${c.bold('dev-workflow')} — set up the YouTrack ticket workflow for a project

For a project that uses GitHub Issues, install with this and then run ${c.cyan('/dev-init')},
which configures the label ladder GitHub needs.

Installs into the project itself: the runtime under ${c.cyan(PAYLOAD_DIR + '/')}, the four
skills under ${c.cyan('.claude/skills/dev-*')}, and the commit hook into
${c.cyan('.claude/settings.json')}. Nothing is installed globally.

Re-run it to update. Files you have edited are reported and left alone.

  --dir <path>   target project directory (default: cwd)
  --print        print the resulting config instead of writing it
  --force        overwrite an existing .dev-workflow.json, and any edited payload file
  --help         this message
`);
  process.exit(0);
}

const targetDir = resolve(opt('--dir', process.cwd()));
const configPath = join(targetDir, '.dev-workflow.json');

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
p.intro(`${c.bgCyan(c.black(' dev-workflow '))}  ${c.dim(targetDir)}`);

if (!existsSync(targetDir)) {
  p.cancel(`No such directory: ${targetDir}`);
  process.exit(1);
}

let existing = null;
if (existsSync(configPath) && !flag('--print')) {
  try {
    existing = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    p.log.warn(`${c.yellow('.dev-workflow.json exists but is not valid JSON')} — it will be replaced.`);
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
  // Written explicitly rather than left to the default, so the file says which
  // tracker it is for. This wizard only configures YouTrack; a GitHub project
  // is set up by /dev-init, which knows about label ladders.
  provider: 'youtrack',
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

const write = bail(await p.confirm({ message: `Write ${c.cyan('.dev-workflow.json')}?`, initialValue: true }));
if (write) {
  writeFileSync(configPath, json, 'utf8');
  p.log.success(`Wrote ${configPath}`);
  p.log.info(
    `It holds no secret${tokenOpRef ? ' — tokenOpRef is a 1Password reference, not a token' : ''}, so it is safe to commit.`,
  );
} else {
  p.log.warn('Skipped — no config written.');
}

// --- 11. install the workflow into the project -------------------------------
// Everything lands inside the project: nothing is registered globally, so the
// skill names are only claimed where they were actually installed.
const existingManifest = readManifest(targetDir);
const verb = existingManifest ? 'Update' : 'Install';

const doInstall = bail(
  await p.confirm({
    message: existingManifest
      ? `${verb} the workflow files in this project (currently ${existingManifest.installation?.version ?? 'unknown'})?`
      : `Install the workflow into ${c.cyan(PAYLOAD_DIR + '/')} and ${c.cyan('.claude/skills/')}?`,
    initialValue: true,
  }),
);

if (doInstall) {
  const s = p.spinner();
  s.start(`${verb === 'Update' ? 'Updating' : 'Installing'} the workflow files`);
  try {
    const result = installPayload({
      sourceRoot: SOURCE_ROOT,
      projectDir: targetDir,
      version: VERSION,
      force: flag('--force'),
    });
    s.stop(`${result.written.length} file(s) written to ${targetDir}`);

    if (result.hookAdded) p.log.success('Commit hook added to .claude/settings.json');
    else p.log.info('Commit hook already registered in .claude/settings.json');

    if (result.removed.length) {
      p.log.info(`Removed ${result.removed.length} file(s) no longer shipped.`);
    }

    // The reason the manifest exists: never overwrite someone's edit silently.
    if (result.skipped.length) {
      p.log.warn(`Kept ${result.skipped.length} file(s) you have edited:`);
      p.note(
        `${result.skipped.slice(0, 10).join('\n')}${result.skipped.length > 10 ? '\n…' : ''}`,
        'Left untouched — re-run with --force to overwrite',
      );
    }

    p.log.info(`${PAYLOAD_DIR}/ is installer-managed. Commit it, and re-run this to update.`);
  } catch (err) {
    s.stop(c.yellow('Could not install the workflow files.'));
    p.log.warn((err.message || '').trim().slice(0, 400));
  }
} else {
  p.log.warn('Skipped — the skills and runtime were not installed.');
}

// --- done --------------------------------------------------------------------
const nextSteps = [
  `${c.cyan('/dev-task ABC-123')}   start work on an issue`,
  `${c.cyan('/dev-bug it broke')}   file one without losing your place`,
  `${c.cyan('/dev-done')}           verify and close out`,
];
if (!tokenOpRef) {
  nextSteps.push('', c.dim('Remember to export $YOUTRACK_TOKEN in the shell Claude Code runs in.'));
}
p.note(nextSteps.join('\n'), 'Next');
p.outro(`${c.green('Ready.')} ${c.dim(`${project} on ${baseUrl}`)}`);
