# jira-to-pr

A local CLI that turns one Jira ticket into one clean GitHub pull request using an AI code agent.

**One ticket in. One PR out.**

## Quick Start

```bash
npm install -g jira-to-pr

cd ~/your-project

jira-to-pr init              # Interactive setup
jira-to-pr PROJ-123 --dry-run # Preview changes
jira-to-pr PROJ-123          # Apply locally, test, then create PR
```

## Configuration

Run `jira-to-pr init` for interactive setup. It auto-detects your GitHub repo and prompts for:

- Jira credentials (base URL, email, API token, project key)
- GitHub token
- AI provider (Claude, OpenAI, or Ollama)

Creates `.jira-to-pr.env` and adds it to `.gitignore`.

### Manual Setup

Create `.jira-to-pr.env`:

```bash
JIRA_BASE_URL=https://company.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=your_token
JIRA_PROJECT_KEY=PROJ

GITHUB_TOKEN=your_token
GITHUB_OWNER=your-org
GITHUB_REPO=your-repo

ANTHROPIC_API_KEY=your_key  # or OPENAI_API_KEY
```

## Usage

```bash
jira-to-pr PROJ-123           # Apply locally, review, then create PR
jira-to-pr PROJ-123 --dry-run # Preview only (no changes applied)
jira-to-pr PROJ-123 --explain # Show AI reasoning upfront
jira-to-pr PROJ-123 --yes     # Skip review, apply directly

jira-to-pr list               # List available tickets
jira-to-pr config             # Show current config
```

### Interactive Mode

After generating code, you'll see a menu:

```
? What would you like to do?
❯ Apply locally - review and test before committing
  Create PR directly - skip local review
  Explain - show AI reasoning
  Retry - regenerate with feedback
  Abort
```

**Two-stage review flow** (recommended):

1. **Apply locally** - Changes are written to your working directory
2. **Review & test** - Run tests, start the app, make manual tweaks if needed
3. **Commit** - When ready, select "Commit & Create PR"

Or select **Create PR directly** to skip local review if you trust the diff.

```
✓ Changes applied locally
────────────────────────────────────────────────────────────
You can now:
  • Run your test suite
  • Start the application locally
  • Review the changes in your editor
  • Make manual adjustments if needed
────────────────────────────────────────────────────────────

? What would you like to do?
❯ Commit & Create PR
  Discard changes - restore original files
  Retry - discard and regenerate with feedback
```

**AI-generated notice:** PRs include a footer noting the changes were AI-generated:
- `🤖 AI-generated code - please review carefully`

### Override Flags

```bash
--allow-dirty         # Allow uncommitted changes in working tree
--allow-large-diff    # Allow diffs exceeding safety limits
--allow-missing-tests # Suppress test coverage warnings
--remote              # Use GitHub API only (no local git)
```

## Claude Code Integration

Use jira-to-pr as an MCP server in Claude Code.

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "jira-to-pr": {
      "command": "jira-to-pr",
      "args": ["mcp"]
    }
  }
}
```

Then in Claude Code:

- "List my Jira tickets"
- "Create a PR for PROJ-123"

For global config, create `~/.jira-to-pr.env`.

## Project Instructions

The tool reads project-specific AI instructions from:

- `CLAUDE.md`
- `.cursor/rules` or `.cursorrules`
- `AGENTS.md`

These guide how code is generated to match your project conventions.

## Safety

- Requires acceptance criteria (with helpful examples if missing)
- Limits files (10) and lines (500) changed
- Warns if behavioral changes lack test updates
- Shows diff preview before applying
- Two-stage review: apply locally, test, then commit
- PRs marked as AI-generated for reviewer awareness

Override limits in config:

```bash
MAX_FILES_TO_CHANGE=20
MAX_LINES_CHANGED=1000
```

## AI Providers

**Claude (default)**

```bash
ANTHROPIC_API_KEY=your_key
```

**OpenAI**

```bash
OPENAI_API_KEY=your_key
```

**Ollama (local)**

```bash
AI_PROVIDER=ollama
OLLAMA_MODEL=llama3.1
```

## License

MIT
