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
  url "https://registry.npmjs.org/claude-dev-workflow/-/claude-dev-workflow-1.18.3.tgz"
  sha256 "d38c4c117e0563bb408d4a7e5f4924a972d64379a4e3580108d0a2bc0daf063d"
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
