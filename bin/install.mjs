#!/usr/bin/env node
/**
 * Interactive installer for the dev-workflow Claude Code skills.
 *
 *   npx claude-dev-workflow@latest                          # configure the project in the cwd
 *   npx claude-dev-workflow@latest --update                 # express: refresh the files
 *   npx claude-dev-workflow@latest --update --reconfigure   # …and then change the config
 *   npx claude-dev-workflow@latest --dir ..                 # …somewhere else
 *   npx claude-dev-workflow@latest --print                  # show the config, write nothing
 *
 * Two things happen here: `.dev-workflow.json` is written for the target project,
 * and the plugin itself is registered with Claude Code. Both are optional and
 * either can be skipped.
 *
 * `@latest` is not decoration. npx keys its cache on the literal spec string and,
 * on a re-run, only checks whether the cached tree satisfies the range it
 * recorded — `1.2.3` satisfies the `^1.2.3` it wrote, so a bare
 * `npx claude-dev-workflow` reruns the stale cached copy indefinitely. `latest`
 * is a dist-tag, so it is re-resolved every time. Every command this file prints
 * spells it out for that reason.
 *
 * `--update` exists because updating used to mean answering the whole wizard
 * again: a dozen questions to change nothing but the version, and no way through
 * at all where there is no TTY. It has two modes, both named:
 *
 *   express        `--update` — refresh the files, keep every value already
 *                  answered. Its one concession to the config is a setting the
 *                  incoming version has and the project's file does not: that
 *                  was never answered, so asking about it is not re-asking. With
 *                  no TTY it writes the default and prints what it chose, which
 *                  is what keeps the path usable in CI, a container or a pipe.
 *   change config  `--update --reconfigure` — the same refresh, then the whole
 *                  wizard with the current values as its defaults. It existed
 *                  before, spelled as the bare command, and nothing said so.
 *
 * The first question is which issue tracker the project uses, because that
 * answer decides every question after it. Until it existed the wizard opened on
 * `YouTrack instance URL` and hardcoded the provider, so a GitHub Issues project
 * met a mandatory URL it could not supply and no sign another tracker existed.
 */
import { execFileSync, execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import * as p from '@clack/prompts';
import c from 'picocolors';

import { listProjects, projectFieldValues, whoami } from '../lib/youtrack.mjs';
import {
  defaultForKey,
  describeValue,
  missingConfigKeys,
  setConfigKey,
} from './lib/config-keys.mjs';
import { baseBranch, commitIdPosition, describeRepo, findRepos } from './lib/detect.mjs';
import { createLabelCommand, ghAuthStatus, ghLabels, ghRepoView, ghVersion } from './lib/gh.mjs';
import { COMMANDS, parseCommand } from './lib/argv.mjs';
import { PAYLOAD_DIR, installPayload, readManifest } from './lib/payload.mjs';
import { buildConfig, pickDefaultPriority, proposeProvider } from './lib/wizard-config.mjs';

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
//
// One parser for two spellings: the verbs a once-installed binary reads
// naturally (`claude-dev-workflow update`) and the flags every documented
// `npx claude-dev-workflow@latest --update` line uses. `flag` and `opt` below
// are the face the rest of this file has always read; they answer from the
// parse so no step downstream knows which spelling was typed.
const parsed = parseCommand(process.argv.slice(2));
const flag = (name) =>
  ({
    '--update': parsed.command === 'update',
    '--reconfigure': parsed.flags.reconfigure,
    '--print': parsed.flags.print,
    '--force': parsed.flags.force,
    '--help': parsed.command === 'help',
    '-h': parsed.command === 'help',
  })[name] ?? false;
const opt = (name, fallback) => (name === '--dir' ? (parsed.flags.dir ?? fallback) : fallback);

const USAGE = `
${c.bold('claude-dev-workflow')} — set up the ticket workflow for a project

Install the tool once, then initialise it in any project:

  ${c.cyan('brew tap ayhid/claude-dev-workflow https://github.com/ayhid/claude-dev-workflow')}
  ${c.cyan('brew install claude-dev-workflow')}         or   ${c.cyan('npm install -g claude-dev-workflow')}
  ${c.cyan('cd your-project && claude-dev-workflow init')}

or run it without installing: ${c.cyan('npx claude-dev-workflow@latest')} — always spelled
${c.cyan('@latest')}, since npx caches by the literal spec string and a bare
${c.cyan('npx claude-dev-workflow')} keeps re-running whatever version it cached first.

Either way it installs into the project itself: the runtime under ${c.cyan(PAYLOAD_DIR + '/')},
the skills under ${c.cyan('.claude/skills/dev-*')}, and the hooks into ${c.cyan('.claude/settings.json')}.
That copy is what a project commits; the global binary only puts it there.

  ${c.cyan('init')}                    the wizard: which tracker, which states, which branch pattern
  ${c.cyan('update')}                  ${c.bold('express')} — refresh the files, keep every value you answered
  ${c.cyan('update --reconfigure')}    ${c.bold('change config')} — refresh, then the wizard, current values as defaults
  ${c.cyan('update --print')}          show what would change, write nothing
  ${c.cyan('version')}                 this binary's version
  ${c.cyan('help')}                    this message

Express asks nothing, with one exception: a setting this version has that your
config does not. That was never answered, so it is asked — labelled as new, and
on its own. With no TTY it writes the default and prints which key it added.

Files you have edited are reported and left alone unless you pass ${c.cyan('--force')}.

The flags spell the same commands — ${c.cyan('--update')}, ${c.cyan('--update --reconfigure')} — and
${c.cyan('--dir <path>')} targets another directory, ${c.cyan('--print')} writes nothing, ${c.cyan('--force')}
overwrites an existing .dev-workflow.json and any edited payload file.

Asks which issue tracker the project uses — YouTrack or GitHub Issues — and
configures that one. To amend an existing config from inside Claude Code, or to
talk it through rather than click, run ${c.cyan('/dev-init')} instead.
`;

if (parsed.command === 'error') {
  console.error(`${c.red(parsed.error)}\n\nusage: claude-dev-workflow [${COMMANDS.join('|')}] [--dir <path>] [--print] [--force]${USAGE}`);
  process.exit(2);
}
if (parsed.command === 'version') {
  console.log(VERSION);
  process.exit(0);
}
if (parsed.command === 'help') {
  console.log(USAGE);
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

/** The one command that reliably fetches a newer version. Printed, never guessed at. */
const UPDATE_COMMAND = 'npx claude-dev-workflow@latest --update';

/** The same update, plus the wizard. The mode nothing used to name. */
const RECONFIGURE_COMMAND = `${UPDATE_COMMAND} --reconfigure`;

/**
 * Copy the payload and skills into the project, and report what happened.
 *
 * Shared by the wizard's final step and the bare `--update` path, so the two
 * cannot drift in what they tell the user — the whole point of `--update` is
 * that it is the same install, minus the questions.
 *
 * @returns {boolean} whether the install completed
 */
function installIntoProject({ force = false, dryRun = false } = {}) {
  const existing = readManifest(targetDir);
  const updating = Boolean(existing);
  const s = p.spinner();
  s.start(dryRun ? 'Checking what would change' : updating ? 'Updating the workflow files' : 'Installing the workflow files');

  try {
    const result = installPayload({
      sourceRoot: SOURCE_ROOT,
      projectDir: targetDir,
      version: VERSION,
      force,
      dryRun,
    });
    s.stop(
      dryRun
        ? `${result.written.length} file(s) would be written to ${targetDir}`
        : `${result.written.length} file(s) written to ${targetDir}`,
    );

    if (dryRun) p.log.info('Dry run — nothing was written.');
    else if (result.hookAdded) {
      const n = result.addedCommands?.length ?? 1;
      p.log.success(`${n} hook(s) added to .claude/settings.json`);
    } else p.log.info('Hooks already registered in .claude/settings.json');

    if (result.removed.length) {
      p.log.info(`${dryRun ? 'Would remove' : 'Removed'} ${result.removed.length} file(s) no longer shipped.`);
    }

    // The reason the manifest exists: never overwrite someone's edit silently.
    if (result.skipped.length) {
      p.log.warn(`Kept ${result.skipped.length} file(s) you have edited:`);
      p.note(
        `${result.skipped.slice(0, 10).join('\n')}${result.skipped.length > 10 ? '\n…' : ''}`,
        'Left untouched — re-run with --force to overwrite',
      );
    }

    p.log.info(`${PAYLOAD_DIR}/ is installer-managed. Commit it, and update with:`);
    p.log.message(c.cyan(UPDATE_COMMAND));
    return true;
  } catch (err) {
    s.stop(c.yellow('Could not install the workflow files.'));
    p.log.warn((err.message || '').trim().slice(0, 400));
    return false;
  }
}

/** One registry entry, rendered as the prompt it describes. */
async function askConfigKey(entry, fallback) {
  const message = `${c.yellow('New setting')} ${c.dim(`(${entry.key})`)} — ${entry.message}`;

  if (entry.type === 'select') {
    return bail(
      await p.select({
        message,
        initialValue: fallback,
        options: entry.options,
        maxItems: 12,
      }),
    );
  }

  // The default as a placeholder rather than as `initialValue`: clack puts an
  // initial value in the buffer with the cursor after it, so anything typed is
  // appended to it — `English` plus `Deutsch` is `EnglishDeutsch`. A key nobody
  // has ever answered is the one prompt most likely to be typed over, so Enter
  // takes the default and a keystroke replaces it.
  const shown = entry.render ? entry.render(fallback) : String(fallback);
  const answer = bail(await p.text({ message, placeholder: shown, defaultValue: shown }));
  return entry.parse ? entry.parse(answer) : String(answer).trim();
}

/**
 * Express mode's only business with `.dev-workflow.json`: add the settings this
 * version knows about that the project's file does not.
 *
 * The narrow rule this relaxes is "the config is the wizard's business, not the
 * updater's". What it keeps is the reason that rule existed — an update must
 * never re-ask a question already answered, and must work where there is no TTY
 * at all. A key absent from the file was never answered, so asking is not
 * re-asking; and with no TTY nothing is asked, the default is written, and the
 * keys it added are printed so the choice is visible in the log rather than
 * lost. That is why `--update` still exits on its own with stdin closed.
 *
 * It only ever **adds**. A key already in the file is never rewritten, reordered
 * or removed, and a config that has them all is left untouched byte for byte —
 * nothing is written at all in that case.
 */
async function addNewConfigKeys({ dryRun = false } = {}) {
  // No config is not an old config: a project with none has answered nothing,
  // and inventing one behind `--update` is the wizard's job, or /dev-init's.
  if (!existsSync(configPath)) return;

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    p.log.warn(`${c.yellow('.dev-workflow.json is not valid JSON')} — leaving it exactly as it is.`);
    return;
  }

  const missing = missingConfigKeys(config);
  if (!missing.length) return;

  const interactive = Boolean(process.stdin.isTTY) && !dryRun;
  const added = [];

  for (const entry of missing) {
    // The default is computed against the config as it stands, so a key derived
    // from one answered a moment ago sees that answer.
    const fallback = defaultForKey(entry, config);
    const value = interactive ? await askConfigKey(entry, fallback) : fallback;
    setConfigKey(config, entry.key, value);
    added.push(`${entry.key} = ${describeValue(value)}`);
  }

  if (dryRun) {
    p.note(added.join('\n'), `${added.length} new setting(s) this version adds`);
    p.log.info('Dry run — the config was not written.');
    return;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  p.note(
    added.join('\n'),
    interactive
      ? 'Added to .dev-workflow.json'
      : c.yellow('Added to .dev-workflow.json — defaults, with no TTY to ask on'),
  );
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
p.intro(`${c.bgCyan(c.black(' dev-workflow '))}  ${c.dim(targetDir)}`);

if (!existsSync(targetDir)) {
  p.cancel(`No such directory: ${targetDir}`);
  process.exit(1);
}

// --- 0. the update path ------------------------------------------------------
// Deliberately *before the first wizard prompt*. Two properties depend on it:
// updating must never mean answering the whole wizard again just to change the
// version, and the installer must work where there is no TTY at all — CI, a
// container, a pipe. A wizard question added above this line silently removes
// both.
//
// `--reconfigure` is the *other* mode, asked for explicitly: the same refresh,
// and then the wizard. It falls through rather than exiting, which is the only
// reason the block below is a fallthrough and not a `process.exit`.
//
// An existing manifest is not required — `--update` on a fresh project is a
// payload install with no config, which is exactly what a project configured by
// /dev-init wants.
const reconfigure = flag('--reconfigure');

if (flag('--update')) {
  const ok = installIntoProject({ force: flag('--force'), dryRun: flag('--print') });
  if (!ok) {
    p.outro(c.yellow('Nothing was updated.'));
    process.exit(1);
  }

  if (!reconfigure) {
    // Express. The only question it may ask is about a key that was never
    // answered, and with no TTY it does not ask that one either.
    await addNewConfigKeys({ dryRun: flag('--print') });
    p.outro(
      flag('--print')
        ? `${c.green('Planned only.')} ${c.dim(`v${VERSION} would be installed in ${targetDir}`)}`
        : `${c.green('Up to date.')} ${c.dim(`v${VERSION} in ${targetDir}`)}`,
    );
    process.exit(0);
  }

  p.log.step(`${c.bold('Change config')} — the wizard, with your current values as its defaults.`);
}

let existing = null;
if (existsSync(configPath)) {
  try {
    existing = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    p.log.warn(
      `${c.yellow('.dev-workflow.json exists but is not valid JSON')} — ${flag('--print') ? 'its values cannot be used as defaults.' : 'it will be replaced.'}`,
    );
  }
  // Read even under `--print`, so what is printed is the config this project
  // would actually get. The confirmation, though, is only worth asking when
  // something would be written — and `--reconfigure` already answered it on the
  // command line.
  if (existing && !flag('--force') && !flag('--print') && !reconfigure) {
    // Said in the terms of whichever tracker it is for: a GitHub config has no
    // project key and no instance URL, and printing `? on ?` at somebody is not
    // a report that a config was found.
    const summary =
      existing.provider === 'github'
        ? `${existing.github?.issuesRepo ?? existing.github?.repo ?? '?'} on GitHub Issues`
        : `${existing.project ?? '?'} on ${existing.baseUrl ?? '?'}`;
    p.log.info(`Found an existing config: ${c.cyan(summary)}`);
    const go = bail(
      await p.confirm({ message: 'Reconfigure it? Current values become the defaults.', initialValue: true }),
    );
    if (!go) {
      p.outro('Left untouched.');
      process.exit(0);
    }
  }
}

// --- 1. which issue tracker --------------------------------------------------
//
// First, and before anything else is asked, because the answer decides every
// question below it: a GitHub project has no instance URL to give, and a
// YouTrack project has no label ladder to map.
//
// The repo proposes an answer and never decides one. A `github.com` origin is a
// strong hint, and a hint is all it is — like everything `detect.mjs` returns,
// a wrong guess here costs a keystroke.
const candidates = findRepos(targetDir).map(describeRepo);
const detectedSlug = candidates.find((r) => r.githubRepo)?.githubRepo ?? null;

const provider = bail(
  await p.select({
    message: 'Which issue tracker does this project use?',
    initialValue: proposeProvider({ existing, detectedSlug }),
    options: [
      {
        value: 'github',
        label: 'GitHub Issues',
        hint: detectedSlug ? `origin is ${detectedSlug}` : 'gh does the auth — there is no token to configure',
      },
      { value: 'youtrack', label: 'YouTrack', hint: 'a JetBrains instance and a project key' },
    ],
  }),
);

// --- 2. the tracker itself ---------------------------------------------------
//
// One branch per backend, each returning the same shape, so every step after
// this one is provider-agnostic — the same reason `lib/provider.mjs` exists.
// What differs between the two is exactly what each backend requires and no
// more: YouTrack needs a URL, a token and a project; GitHub needs a repository
// and a label per ladder rung.
//
//   { identity        the config block naming the tracker, spread verbatim
//     stateValues     what start/review/done/abandon are chosen from
//     ladder          written to states.ladder
//     issueTypes      [] when the tracker has no notion of one
//     priorities      null likewise — GitHub reports capabilities.priorities false
//     labels          the repository's real labels, for the typed-branch step
//     labelHints      commands the user must run; the wizard runs none of them
//     summary }       the outro line

/**
 * YouTrack: instance, token, verification, project, and the project's own field
 * values. The states, types and priorities are read off the live project rather
 * than proposed, which is the whole reason this path talks to the API at all.
 */
async function configureYouTrack() {
  // --- instance --------------------------------------------------------------
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

  // --- token -----------------------------------------------------------------
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

  // --- verify, and use the live instance to fill in the rest -----------------
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

  // --- project ---------------------------------------------------------------
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

  // --- states, from the project's real field values --------------------------
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

  return {
    identity: {
      baseUrl,
      project,
      ...(projectId ? { projectId } : {}),
      ...(tokenOpRef ? { tokenOpRef } : {}),
    },
    stateValues,
    ladder: stateValues.length ? stateValues : (existing?.states?.ladder ?? []),
    issueTypes: typeValues,
    priorities: priorityValues,
    defaultPriority: pickDefaultPriority(priorityValues, existing?.defaultPriority),
    labels: [],
    labelHints: [],
    tokenOpRef,
    summary: `${project} on ${baseUrl}`,
  };
}

/**
 * GitHub Issues: the repository, and a label for every ladder rung but the first.
 *
 * Two rules from `lib/github.mjs` drive the whole shape of this, and neither is
 * a preference:
 *
 *   - the ladder must be explicit and its **first rung is what an issue carrying
 *     no ladder label is**. Derive it and every untouched issue reads as started.
 *   - the rung → label mapping is required, never inferred. A label named after
 *     its rung is a guess that is right often enough to be dangerous, so the
 *     repository's real labels are read and mapped onto.
 *
 * Nothing here writes to the repository. A label that does not exist yet is
 * collected and printed as the exact `gh label create` command — adding labels
 * to somebody's repo is a visible, permanent change, and it is not this
 * installer's to make.
 */
async function configureGitHub() {
  const repo = bail(
    await p.text({
      message: 'Which GitHub repository holds the issues?',
      placeholder: 'owner/name',
      initialValue: existing?.github?.issuesRepo ?? existing?.github?.repo ?? detectedSlug ?? '',
      validate: (v) => (/^[\w.-]+\/[\w.-]+$/.test(v ?? '') ? undefined : 'owner/name, as GitHub spells it.'),
    }),
  );

  // --- verify ----------------------------------------------------------------
  // The same bargain the YouTrack path strikes: talk to the real thing before
  // writing a config that claims it works. `gh` carries the authentication, so
  // there is no token to ask for — only whether it is there and can write.
  let online = false;
  let labels = [];

  {
    const s = p.spinner();
    s.start(`Verifying ${repo} with gh`);

    // In order, and each only worth asking if the last one held: an old `gh`
    // cannot tell declined work from shipped, an unauthenticated one cannot
    // answer at all, and read-only access produces a config that fails on its
    // first write. Whichever fails is the one reported — never a generic
    // "could not verify" over the sentence that named the problem.
    const version = await ghVersion();
    const auth = version.ok ? await ghAuthStatus() : null;
    const view = auth?.ok ? await ghRepoView(repo) : null;
    const failed = [version, auth, view].find((r) => r && !r.ok);

    if (failed) {
      s.stop(c.yellow(failed.error));
    } else {
      online = true;
      s.stop(
        `gh ${version.data}${auth.data ? `, authenticated as ${c.green(auth.data)}` : ''} — ${c.green(view.data.viewerPermission)} on ${view.data.nameWithOwner}.`,
      );
    }
  }

  if (online) {
    const s = p.spinner();
    s.start(`Reading the labels of ${repo}`);
    const list = await ghLabels(repo);
    if (list.ok) {
      labels = list.data;
      s.stop(`${labels.length} label(s) found.`);
    } else {
      s.stop(c.yellow(`Could not read the labels: ${list.error}`));
    }
  } else {
    const go = bail(
      await p.confirm({
        message: 'Continue without gh? The repository and its labels will not be validated.',
        initialValue: true,
      }),
    );
    if (!go) {
      p.cancel('Aborted — fix gh and run again.');
      process.exit(1);
    }
  }

  // --- the ladder ------------------------------------------------------------
  const ladder = bail(
    await p.text({
      message: `The states this project moves through, first to last ${c.dim('(comma-separated)')}`,
      placeholder: 'Backlog, In Progress, In Review, Done',
      initialValue: (existing?.states?.ladder?.length ? existing.states.ladder : ['Backlog', 'In Progress', 'In Review', 'Done']).join(', '),
      validate: (v) => {
        const rungs = String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
        if (rungs.length < 2) return 'At least two: one meaning untouched, one meaning finished.';
        if (new Set(rungs.map((r) => r.toLowerCase())).size !== rungs.length) return 'Each rung once.';
        return undefined;
      },
    }),
  )
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  p.log.info(
    `${c.cyan(ladder[0])} needs no label — it is what an issue carrying none of the others ${c.bold('is')}.`,
  );

  // --- a label per rung, from the ones the repository really has --------------
  const TYPE_IT = '__type_it';
  const labelFor = {};
  const labelHints = [];

  for (const rung of ladder.slice(1)) {
    const previous = existing?.github?.labels?.[rung];
    const suggested = previous ?? `status: ${rung.toLowerCase()}`;
    let chosen;

    if (labels.length) {
      const known = labels.includes(suggested) ? suggested : (labels.find((l) => l.toLowerCase() === rung.toLowerCase()) ?? null);
      chosen = bail(
        await p.select({
          message: `Which label marks ${c.cyan(rung)}?`,
          initialValue: known ?? TYPE_IT,
          options: [
            ...labels.map((l) => ({ value: l, label: l })),
            { value: TYPE_IT, label: 'Something else…', hint: 'a name this repo does not have yet' },
          ],
          maxItems: 12,
        }),
      );
    } else {
      chosen = TYPE_IT;
    }

    if (chosen === TYPE_IT) {
      chosen = bail(
        await p.text({
          message: `Label name for ${c.cyan(rung)}`,
          placeholder: suggested,
          initialValue: suggested,
          validate: (v) => (v?.trim() ? undefined : 'Required — every rung but the first needs one.'),
        }),
      ).trim();
    }

    labelFor[rung] = chosen;
    // Only a label the repository is known to be missing. With no label list
    // read, nothing is known, so nothing is claimed.
    if (labels.length && !labels.includes(chosen)) labelHints.push(createLabelCommand(chosen, repo));
  }

  return {
    identity: { github: { repo, labels: labelFor } },
    stateValues: ladder,
    ladder,
    // GitHub has no type field and no ordered priority. Types appear only if the
    // project maps them onto labels, which the typed-branch step asks about.
    issueTypes: [],
    priorities: null,
    defaultPriority: null,
    labels,
    labelHints,
    tokenOpRef: null,
    summary: `${repo} on GitHub Issues`,
  };
}

const tracker = provider === 'github' ? await configureGitHub() : await configureYouTrack();

// --- 3. the ladder rungs that mean something ---------------------------------
const pickState = async (message, hint, fallback, values, { allowNone = false } = {}) => {
  if (values.length) {
    const guess = values.find((s) => s.toLowerCase() === String(fallback ?? '').toLowerCase());
    return bail(
      await p.select({
        message: `${message} ${c.dim(`(${hint})`)}`,
        initialValue: guess ?? (allowNone ? '' : fallback),
        options: [
          ...values.map((s) => ({ value: s, label: s })),
          ...(allowNone ? [{ value: '', label: 'None', hint: 'leave it unset' }] : []),
        ],
        maxItems: 12,
      }),
    );
  }
  if (allowNone) {
    return bail(
      await p.text({
        message: `${message} ${c.dim(`(${hint})`)}`,
        initialValue: fallback ?? '',
        defaultValue: '',
        placeholder: 'none',
      }),
    );
  }
  return bail(await p.text({ message: `${message} ${c.dim(`(${hint})`)}`, initialValue: fallback }));
};

const states = {
  start: await pickState('State meaning "started"', '/dev-task moves here', existing?.states?.start ?? 'In Progress', tracker.stateValues),
  review: await pickState('State meaning "in review"', 'set when a PR opens', existing?.states?.review ?? 'In Review', tracker.stateValues),
  done: await pickState('State meaning "finished"', '/dev-done moves here', existing?.states?.done ?? 'Done', tracker.stateValues),
  // The one state with no default anywhere. Everything else in this tool moves a
  // ticket forward, so nothing would notice or correct a wrong value here — it
  // is offered, with the first rung preselected, and never assumed.
  abandon: await pickState(
    'State a ticket goes back to when its work is thrown away',
    'dev.mjs abandon; None to leave it unset',
    existing?.states?.abandon ?? tracker.stateValues[0] ?? '',
    tracker.stateValues,
    { allowNone: true },
  ),
  ladder: tracker.ladder,
};
// --- 4. ticket language ------------------------------------------------------
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

// --- 5. repos ----------------------------------------------------------------
// `candidates` was gathered before the tracker question, which needed the same
// scan to spot a github.com origin.
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
        // Clack renders a submitted text prompt as `value || placeholder`, so a
        // prompt that accepts a blank answer and has no placeholder prints the
        // string "undefined" back at you. Every `defaultValue: ''` prompt below
        // carries one for that reason; tests/install-prompts.test.mjs enforces it.
        placeholder: 'none',
      }),
    );
    const checks = checksAnswer.split('&&').map((s) => s.trim()).filter(Boolean);

    const when = bail(
      await p.text({
        message: `What belongs in ${c.cyan(path)}? ${c.dim('(routing hint; blank if it is the only one)')}`,
        initialValue: prior?.when ?? '',
        defaultValue: '',
        placeholder: 'none',
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

// --- 6. commit convention ----------------------------------------------------
const sampleId = provider === 'github' ? '#123' : 'ABC-123';
const rootRepo = candidates.find((r) => r.path === '.') ?? candidates[0];
const detectedTypes = candidates.map((r) => r.types).find((t) => t?.length);
const conventionSource = candidates.find((r) => r.types?.length)?.conventionSource;
const detectedPosition = rootRepo ? commitIdPosition(rootRepo.dir, provider) : null;

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
      // Shown in the ID shape this project will actually commit: `#123` for
      // GitHub, `ABC-123` for YouTrack. `lib/issueid.mjs` derives that from the
      // provider alone, so there is no pattern to configure here.
      { value: 'suffix', label: 'Suffix', hint: `feat(api): add thing (${sampleId})  — commitlint-safe` },
      { value: 'prefix', label: 'Prefix', hint: `${sampleId} feat(api): add thing` },
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

/** What `lib/config.mjs` ships when a project's commitlint config says nothing. */
const DEFAULT_COMMIT_TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore', 'perf', 'ci', 'revert', 'build'];

/**
 * A proposed issue-type → commit-type mapping.
 *
 * A proposal, not an inference: the assembled JSON is shown in full and
 * confirmed before anything is written, and at runtime an unmapped type is an
 * error naming the key rather than a guess. Only pairs where the commit type
 * actually exists in this project are written — mapping to a type its commitlint
 * config rejects would produce a branch its own commits could not reference.
 */
function branchTypeMap(issueTypes, commitTypes) {
  const rules = [
    [/bug|defect|incident/i, 'fix'],
    [/feature|story|epic|enhancement/i, 'feat'],
    [/improvement|refactor|debt/i, 'refactor'],
    [/doc/i, 'docs'],
    [/task|chore|maintenance/i, 'chore'],
  ];
  const out = {};
  for (const t of issueTypes ?? []) {
    const hit = rules.find(([re]) => re.test(t))?.[1] ?? 'chore';
    if (commitTypes.includes(hit)) out[t] = hit;
    else if (commitTypes.includes('chore')) out[t] = 'chore';
  }
  return out;
}

// --- 7. isolation and delivery -----------------------------------------------
//
// Two working-style questions, asked in working-style terms. Both have real
// consequences — one decides which directory every later command runs in, the
// other whether finished work waits for a review that may never come — so
// neither is inferred from the repo.
const base = existing?.branch?.base ?? (rootRepo ? baseBranch(rootRepo.dir) : 'main');

const branchMode = bail(
  await p.select({
    message: 'Where should starting a ticket check the code out?',
    initialValue: existing?.branch?.mode ?? 'worktree',
    options: [
      {
        value: 'worktree',
        label: 'A separate directory (git worktree)',
        hint: 'leaves this checkout and any work in progress alone',
      },
      { value: 'branch', label: 'This checkout', hint: 'switches branch in place; refuses if dirty' },
    ],
  }),
);

const deliveryMode = bail(
  await p.select({
    message: `When a ticket is finished, how should it reach ${c.cyan(base)}?`,
    initialValue: existing?.delivery?.mode ?? 'pr',
    options: [
      { value: 'pr', label: 'Open a pull request', hint: 'reviewed, then merged' },
      {
        value: 'direct',
        label: `Land it on ${base}`,
        hint: 'rebase, fast-forward, push — for a solo project',
      },
    ],
  }),
);

const useTypedBranches = bail(
  await p.confirm({
    message: `Prefix branches with the change type? ${c.dim(`(feat/${sampleId.replace('#', '')}-slug rather than ${sampleId.replace('#', '')}-slug)`)}`,
    // Off by default on GitHub unless the project already does it: the type has
    // to come from somewhere, and on GitHub that means labels the project may
    // not keep. Without them every branch would render the `chore` fallback.
    initialValue: existing?.branch?.pattern
      ? existing.branch.pattern.includes('<type>')
      : provider !== 'github',
  }),
);

// A branch carries a type only if the tracker can say what an issue's type is.
// YouTrack has a Type field; GitHub has one only where the project maps types
// onto labels, which is exactly what `github.labels.type` records and what
// `capabilities.types` is read off. Asked here rather than as a step of its own,
// so a project that does not want typed branches is never asked at all.
let issueTypes = tracker.issueTypes;
let typeLabels = null;

if (provider === 'github' && useTypedBranches) {
  const DEFAULT_TYPE_LABELS = { Bug: 'bug', Feature: 'enhancement' };
  const previous = existing?.github?.labels?.type ?? null;
  const proposed = previous ?? DEFAULT_TYPE_LABELS;
  const known = tracker.labels.length ? tracker.labels : null;

  const answer = bail(
    await p.text({
      message: `Which labels mean which issue type? ${c.dim('(Type=label, comma-separated; blank for none)')}`,
      initialValue: Object.entries(proposed)
        .filter(([, label]) => !known || known.includes(label))
        .map(([type, label]) => `${type}=${label}`)
        .join(', '),
      defaultValue: '',
      placeholder: 'none',
    }),
  );

  const parsed = {};
  for (const pair of answer.split(',')) {
    const [type, label] = pair.split('=').map((x) => x.trim());
    if (type && label) parsed[type] = label;
  }

  if (Object.keys(parsed).length) {
    typeLabels = parsed;
    issueTypes = Object.keys(parsed);
    for (const label of Object.values(parsed)) {
      if (known && !known.includes(label)) tracker.labelHints.push(createLabelCommand(label, tracker.identity.github.repo));
    }
  } else {
    p.log.info(`No type labels — branches will use ${c.cyan('branch.fallbackType')} for their prefix.`);
  }
}

// --- 8. reviewer -------------------------------------------------------------
// Only meaningful with a pull request in the picture; a reviewer on a `direct`
// project is a field nothing will ever read.
const reviewer =
  deliveryMode === 'pr'
    ? bail(
        await p.text({
          message: `Default PR reviewer ${c.dim('(blank for none)')}`,
          initialValue: existing?.reviewer ?? '',
          defaultValue: '',
          placeholder: 'none',
        }),
      )
    : '';

// --- 9. assemble -------------------------------------------------------------
// The shape itself lives in `bin/lib/wizard-config.mjs`, as a pure function of
// these answers: a script full of prompts cannot be run without a TTY, so
// nothing could assert what the wizard emitted while it was inline here.
const config = buildConfig({
  provider,
  identity: tracker.identity,
  language,
  states,
  branchMode,
  base,
  worktreeDir: existing?.branch?.worktreeDir ?? null,
  useTypedBranches,
  // The issue types are the ones this project really has — read off the YouTrack
  // project, or mapped onto GitHub labels a step ago — put against the commit
  // types detected from its commitlint config. Only types that exist on both
  // sides are written: a mapping to a commit type the project does not have
  // would be refused at branch time.
  branchTypes: branchTypeMap(issueTypes, detectedTypes ?? DEFAULT_COMMIT_TYPES),
  deliveryMode,
  deliveryRemote: existing?.delivery?.remote ?? null,
  position,
  requireType,
  enforce,
  commitTypes: detectedTypes ?? null,
  noTicketEscape: existing?.commit?.noTicketEscape ?? 'chore(no-ticket)',
  issueTypes,
  priorities: tracker.priorities,
  defaultPriority: tracker.defaultPriority,
  reviewer,
  repos,
  notes: existing?.notes ?? null,
  typeLabels,
});

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
    `It holds no secret${tracker.tokenOpRef ? ' — tokenOpRef is a 1Password reference, not a token' : ''}, so it is safe to commit.`,
  );
} else {
  p.log.warn('Skipped — no config written.');
}

// --- 10. install the workflow into the project -------------------------------
// Everything lands inside the project: nothing is registered globally, so the
// skill names are only claimed where they were actually installed.
// `--update --reconfigure` refreshed them first, before the wizard: asking a
// second time would be asking whether to redo what was already done.
if (flag('--update')) {
  p.log.info(`The workflow files were refreshed before the questions — ${c.cyan(`v${VERSION}`)}.`);
} else {
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

  if (doInstall) installIntoProject({ force: flag('--force') });
  else p.log.warn('Skipped — the skills and runtime were not installed.');
}

// --- done --------------------------------------------------------------------
const pad = ' '.repeat(Math.max(0, 'ABC-123'.length - sampleId.length));
const nextSteps = [
  `${c.cyan(`/dev-task ${sampleId}`)}${pad}   start work on an issue`,
  `${c.cyan('/dev-bug it broke')}   file one without losing your place`,
  `${c.cyan('/dev-done')}           verify and close out`,
  '',
  // Printed even on a fresh install: this line, and the README, are the only
  // channels that reach a project once it is installed. Nothing inside the
  // payload can tell a version that predates the update check that it is stale.
  //
  // Both modes, named, because the second was undiscoverable while only the
  // first was ever printed.
  c.dim('Update later with:'),
  `${c.cyan(UPDATE_COMMAND)}                 ${c.dim('files only, config untouched')}`,
  `${c.cyan(RECONFIGURE_COMMAND)}   ${c.dim('…and change these answers')}`,
];
if (provider === 'youtrack' && !tracker.tokenOpRef) {
  nextSteps.push('', c.dim('Remember to export $YOUTRACK_TOKEN in the shell Claude Code runs in.'));
}
p.note(nextSteps.join('\n'), 'Next');

// Labels the repository does not have yet. Printed, never created: adding a
// label is a visible, permanent change to somebody's repo, and the adapter
// refuses to make one silently for the same reason.
if (tracker.labelHints.length) {
  p.note(
    [...new Set(tracker.labelHints)].join('\n'),
    c.yellow('Run these first — the ladder needs labels this repo does not have yet'),
  );
}

p.outro(`${c.green('Ready.')} ${c.dim(tracker.summary)}`);
