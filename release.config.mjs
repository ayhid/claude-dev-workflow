/**
 * Automated releases. Repo-local development tooling; not shipped.
 *
 * Releases are fully automatic on `main`, but the job that runs this is gated
 * on both CI jobs passing (`needs: [test, install]` in .github/workflows/ci.yml)
 * — nothing publishes over a red tree. What CI cannot prove is a *write path*
 * against a live tracker, which is why the pre-push checklist in the repo-local
 * `/release` skill still has to be run by hand before pushing to `main`.
 */
export default {
  branches: ['main'],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    '@semantic-release/changelog',
    '@semantic-release/npm',

    // Not optional. `main` is the distribution channel for the `github:` install
    // path, and bin/lib/payload.mjs stamps package.json.version into every
    // project's _dev-workflow/_config/manifest.json — the only way a user can
    // tell they are stale. Without this plugin the bump lands in the npm tarball
    // alone and every `github:` install reports a stale version forever.
    [
      '@semantic-release/git',
      {
        assets: ['package.json', 'package-lock.json', 'CHANGELOG.md'],
        // The default appends the whole release notes as a body, whose long
        // lines @commitlint/config-conventional's body-max-line-length rejects.
        // A short message is why this repo needs no HUSKY=0 in CI: the rule that
        // nothing bypasses git hooks holds for our own release too.
        //
        // `[skip ci]` stops the bump commit from re-triggering the workflow.
        message: 'chore(release): ${nextRelease.version} [skip ci]',
      },
    ],

    '@semantic-release/github',
  ],
};
