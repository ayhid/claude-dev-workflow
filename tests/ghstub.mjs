/**
 * A `gh` that answers from disk, and the repository shape the tests drive it in.
 *
 * Shared rather than copied, for the reason everything else here is shared: two
 * stubs would drift, and a test suite whose fake disagrees with itself proves
 * nothing about the command under test. Exported as a module rather than
 * written as tests (like `provider.contract.mjs`) so `node --test tests/*.test.mjs`
 * does not try to run it.
 *
 * What it is good for and what it is not: it can prove *ordering* and *refusal*
 * — that a command wrote nothing before its check, that a rejected write left
 * the branch alone — because those are observable in the call log. It cannot
 * prove anything about the real API, and no stub can; `CLAUDE.md` says so at
 * length, and this file does not pretend otherwise.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sh } from '../lib/sh.mjs';
import { makeVcs } from '../lib/vcs.mjs';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const git = async (dir, ...args) => {
  const r = await sh('git', ['-C', dir, ...args]);
  if (!r.ok) throw new Error(`git ${args.join(' ')} in ${dir} failed: ${r.stderr}`);
  return r.stdout.trim();
};

/**
 * The stub itself.
 *
 * State lives in files so a test can set it up and read it back: `$GH_STATE`
 * holds the issue's labels, `$GH_PRS` the pull requests to report, `$GH_LOG`
 * every call made, and `$GH_COMMENT` whatever was posted. `$GH_FAIL_EDIT=1`
 * makes the tracker reject a write, which is how the ordering rules are tested.
 */
const GH_STUB = `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$GH_LOG"
[ "\${1:-}" = "--version" ] && { echo "gh version 2.40.0 (2024-01-01)"; exit 0; }
[ "\${1:-}" = "auth" ] && exit 0
if [ "\${GH_FAIL_EDIT:-}" = "1" ] && [ "\${2:-}" = "edit" ]; then
  echo "gh: the label could not be applied" >&2
  exit 1
fi
case "\${1:-} \${2:-}" in
  "issue view")
    printf '{"number":12,"title":"Half a thing","body":"","state":"OPEN","stateReason":null,"url":"https://github.com/o/r/issues/12","labels":[%s],"assignees":[],"author":{"login":"a"},"createdAt":"2026-01-01T00:00:00Z","comments":[]}\\n' "$(cat "$GH_STATE")"
    ;;
  "issue list")
    printf '[{"number":12,"state":"OPEN","stateReason":null,"labels":[%s]}]\\n' "$(cat "$GH_STATE")"
    ;;
  "api graphql")
    # The batched state read. Answers by exact number, like the real one: the
    # repository this stub stands in for holds issue 12 and nothing else, so
    # every other number asked about is simply absent from the answer.
    fields=""
    for n in $(printf '%s' "$*" | grep -o 'issue(number: [0-9]*)' | grep -o '[0-9][0-9]*'); do
      [ "$n" = "12" ] || continue
      [ -n "$fields" ] && fields="$fields,"
      fields="$fields\\"i12\\":{\\"number\\":12,\\"state\\":\\"OPEN\\",\\"stateReason\\":null,\\"labels\\":{\\"nodes\\":[$(cat "$GH_STATE")]}}"
    done
    printf '{"data":{"repository":{%s}}}\\n' "$fields"
    ;;
  "issue edit")
    next=""
    while [ $# -gt 0 ]; do
      [ "$1" = "--add-label" ] && next="{\\"name\\":\\"$2\\"}"
      shift
    done
    printf '%s' "$next" > "$GH_STATE"
    ;;
  "issue comment") cat >> "$GH_COMMENT" ;;
  "label list") echo '[{"name":"status: in progress"},{"name":"status: in review"},{"name":"status: done"}]' ;;
  "pr list") cat "$GH_PRS" ;;
esac
exit 0
`;

/** The project config the stub answers for: a GitHub repo with a four-rung ladder. */
export const CONFIG = {
  provider: 'github',
  github: {
    repo: 'o/r',
    labels: {
      'In Progress': 'status: in progress',
      'In Review': 'status: in review',
      Done: 'status: done',
    },
  },
  states: {
    ladder: ['Backlog', 'In Progress', 'In Review', 'Done'],
    start: 'In Progress',
    review: 'In Review',
    done: 'Done',
    abandon: 'Backlog',
  },
  branch: { pattern: '<ID>-<slug>', base: 'main', mode: 'worktree' },
};

/**
 * A repo on `main`, a ticket branch with one unmerged commit checked out in a
 * worktree, and a second ticket branch nobody has mounted.
 */
export async function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'recover-'));
  const repo = join(root, 'repo');
  const wt = join(root, 'repo', '.worktrees', 'feat-12-thing');

  await sh('git', ['init', '-b', 'main', repo]);
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await git(repo, 'config', 'user.name', 'Test');
  await git(repo, 'commit', '--allow-empty', '-m', 'root');

  await git(repo, 'worktree', 'add', wt, '-b', 'feat/12-thing', 'main');
  await git(wt, 'commit', '--allow-empty', '-m', 'feat(x): half of it (#12)');
  await git(repo, 'branch', 'fix/13-other', 'main');

  return { root, repo, wt, vcs: makeVcs({ run: sh }) };
}

/**
 * The scaffold, plus a config file and a `gh` on PATH that answers from disk.
 *
 * `dev(args)` runs the real CLI the way the skills do — a child process, with
 * the project root pinned so nothing resolves back to this repository's own
 * config — and returns its exit code and output.
 */
export async function withStubGh({ labels = '{"name":"status: in progress"}', prs = [], config = CONFIG } = {}) {
  const s = await scaffold();
  writeFileSync(join(s.repo, '.dev-workflow.json'), `${JSON.stringify(config, null, 2)}\n`);

  const bin = join(s.root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), GH_STUB);
  chmodSync(join(bin, 'gh'), 0o755);

  const paths = {
    log: join(s.root, 'gh.log'),
    state: join(s.root, 'gh.state'),
    comment: join(s.root, 'gh.comment'),
    prs: join(s.root, 'gh.prs'),
  };
  writeFileSync(paths.log, '');
  writeFileSync(paths.state, labels);
  writeFileSync(paths.comment, '');
  writeFileSync(paths.prs, JSON.stringify(prs));

  const dev = (args, extraEnv = {}) =>
    new Promise((done) => {
      execFile(
        process.execPath,
        [join(REPO_ROOT, 'scripts', 'dev.mjs'), ...args],
        {
          cwd: s.repo,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            CLAUDE_PROJECT_DIR: s.repo,
            GH_LOG: paths.log,
            GH_STATE: paths.state,
            GH_COMMENT: paths.comment,
            GH_PRS: paths.prs,
            ...extraEnv,
          },
        },
        (err, stdout, stderr) => done({ code: err?.code ?? 0, stdout, stderr }),
      );
    });

  return { ...s, dev, read: (k) => readFileSync(paths[k], 'utf8') };
}
