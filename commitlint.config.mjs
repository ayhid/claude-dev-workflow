/**
 * Repo-local commit validation. Not shipped: this is the development surface,
 * and nothing here is copied into a user's project.
 *
 * It is the second half of an enforcement pair, not a duplicate of the first.
 * `hooks/check-commit-ticket.sh` is a Claude Code PreToolUse guard, so it only
 * ever sees `git commit -m` issued through the agent — it says so itself, and
 * defers on editor commits, `-F` files and amends. Husky's `commit-msg` hook is
 * what catches those, which is every commit a human types by hand.
 *
 * Division of labour: commitlint owns the conventional-commit *shape*, the hook
 * owns the *issue reference*. Neither restates the other's rule.
 *
 * `type-enum` is deliberately left to @commitlint/config-conventional rather
 * than re-listed here — its enum already matches the hook's default `types=`
 * exactly, and tests/commitlint.test.mjs fails if the two ever drift apart.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // No scope-enum. semantic-release commits its own version bump as
    // `chore(release): …`, and an allowlist would reject the release itself.
    //
    // The subject carries an issue ID in parentheses — `feat(api): add it
    // (ABC-1)` — so the trailing-period ban must not extend to it. The default
    // already allows this; it is spelled out because the two rules look like
    // they conflict and a future edit should know they do not.
    'subject-full-stop': [2, 'never', '.'],
  },
};
