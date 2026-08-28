/**
 * Is this a greenfield project or a brownfield one?
 *
 *   dev.mjs assess [--repo PATH] [--json]
 *
 * The two need different first moves, and the difference is not a matter of
 * taste: a brownfield codebase has years of decisions in it, some written down,
 * some written down and no longer true. Starting work there without reading
 * first is how a session reimplements something that already exists.
 *
 * This measures and proposes; it never decides and never writes. `/dev-init`
 * runs it and asks, and the answer goes in the config as `stage` so it is
 * settled once rather than re-derived — differently — every session.
 *
 * Discovery runs off `git ls-files`, so ignored files are excluded for free and
 * `node_modules` never has to be special-cased.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';

import { AGENT_FILES, classifyPath } from '../../lib/ingest.mjs';
import { sh } from '../../lib/sh.mjs';
import { assessStage, describeStage } from '../../lib/stage.mjs';
import { makeVcs } from '../../lib/vcs.mjs';
import { context, resolveRepo, UserError } from './common.mjs';

const USAGE = 'usage: dev.mjs assess [--repo PATH] [--json]';

function parseArgs(argv) {
  const opts = { json: false, repo: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--repo') opts.repo = argv[++i] ?? '';
    else throw new UserError(`unknown argument '${a}'\n\n${USAGE}`);
  }
  return opts;
}

/**
 * Everything measurable about the repo, or null per signal where it could not
 * be read. Null matters: it makes the signal abstain rather than score zero.
 */
export async function gatherSignals(dir, { run = sh } = {}) {
  const git = async (args) => {
    const r = await run('git', ['-C', dir, ...args]);
    return r.ok ? r.stdout : null;
  };

  const files = (await git(['ls-files'])) ?? '';
  const tracked = files ? files.split('\n').filter(Boolean) : [];

  const docs = tracked.filter((p) => classifyPath(p) === 'doc');
  const sourceFiles = tracked.filter((p) => classifyPath(p) === 'source');

  // Size as well as count, because the two fail differently: a generated
  // scaffold is many small files, and an imported codebase can be a handful of
  // enormous ones. Either alone would miss half the cases the verdict turns on.
  const bytesOf = (list) => {
    let total = 0;
    for (const path of list) {
      try {
        total += statSync(join(dir, path)).size;
      } catch {
        // Tracked but not on disk — a sparse checkout, a broken link. It
        // contributes nothing rather than failing the whole assessment.
      }
    }
    return total;
  };

  const docBytes = bytesOf(docs);
  const sourceBytes = bytesOf(sourceFiles);

  const count = await git(['rev-list', '--count', 'HEAD']);
  const rootCommit = await git(['log', '--max-parents=0', '--format=%cI']);
  const authors = await git(['log', '--format=%ae']);

  const first = rootCommit ? rootCommit.split('\n').filter(Boolean).pop() : null;
  const ageDays = first ? Math.max(0, Math.floor((Date.now() - Date.parse(first)) / 86_400_000)) : null;

  return {
    commits: count ? Number(count) : null,
    ageDays: Number.isFinite(ageDays) ? ageDays : null,
    contributors: authors ? new Set(authors.split('\n').filter(Boolean)).size : null,
    sourceFiles: tracked.length ? sourceFiles.length : null,
    sourceBytes: tracked.length ? sourceBytes : null,
    docBytes: tracked.length ? docBytes : null,
    tests: tracked.length ? tracked.some((p) => /(^|\/)(tests?|spec|__tests__)\//i.test(p) || /\.(test|spec)\./i.test(p)) : null,
    ci: tracked.length
      ? tracked.some((p) => p.startsWith('.github/workflows/') || /^(\.gitlab-ci\.yml|Jenkinsfile|\.circleci\/)/.test(p))
      : null,
    agentFiles: AGENT_FILES.filter((f) => tracked.includes(f)),
    docs,
  };
}

export async function run(argv) {
  const opts = parseArgs(argv);
  const { config, root } = await context();
  const vcs = makeVcs({ run: sh });

  const configured = resolveRepo(config, root, opts.repo);
  const dir = await vcs.mainCheckout(configured.dir);

  const signals = await gatherSignals(dir);
  const assessment = assessStage(signals);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...assessment, signals, recorded: config.stage ?? null }, null, 2)}\n`);
    return 0;
  }

  const L = [`repo:     ${configured.path} (${dir})`];
  if (config.stage) {
    // Already settled. Say so first, and say what the signals think now — a
    // project that was greenfield last year is the normal way this goes stale.
    L.push(`recorded: ${config.stage}   (in .dev-workflow.json)`);
  }
  L.push(...describeStage(assessment, signals));

  if (assessment.verdict === 'brownfield') {
    L.push('', `${signals.docs.length} document${signals.docs.length === 1 ? '' : 's'} to read: dev.mjs ingest scan`);
  }
  process.stdout.write(`${L.join('\n')}\n`);
  return 0;
}
