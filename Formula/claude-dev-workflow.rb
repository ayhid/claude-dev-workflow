# Homebrew formula for the dev-workflow installer.
#
# Lives in this repository rather than a tap of its own, so a release cannot
# leave it behind: the release job rewrites `url` and `sha256` from the tarball
# the registry actually serves (tools/bump-formula.mjs) and commits them. Tap
# by URL, then install:
#
#   brew tap ayhid/claude-dev-workflow https://github.com/ayhid/claude-dev-workflow
#   brew install claude-dev-workflow
#
# The binary installs the workflow *into a project* — `claude-dev-workflow init`
# in its directory, or `dw init`, the same file under its short name. Nothing
# else lands globally.
class ClaudeDevWorkflow < Formula
  desc "Ticket-driven dev workflow for Claude Code, against YouTrack or GitHub Issues"
  homepage "https://github.com/ayhid/claude-dev-workflow"
  url "https://registry.npmjs.org/claude-dev-workflow/-/claude-dev-workflow-1.20.1.tgz"
  sha256 "2ecfdee2d16c05e29fd2a967a3a29c2887ca0be3eeb94cef10f3a73b0f8561a7"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/claude-dev-workflow version").strip
    assert_equal version.to_s, shell_output("#{bin}/dw version").strip
  end
end
