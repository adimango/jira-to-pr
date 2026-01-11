# jira-to-pr

A local CLI that turns one Jira ticket into one clean GitHub pull request using an AI code agent.

**One ticket in. One PR out.**

## Quick Start

```bash
npm install -g jira-to-pr

cd ~/your-project

jira-to-pr init              # Interactive setup
jira-to-pr PROJ-123 --dry-run # Preview changes
jira-to-pr PROJ-123          # Create PR
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
jira-to-pr PROJ-123           # Create PR from ticket
jira-to-pr PROJ-123 --dry-run # Preview only
jira-to-pr PROJ-123 --explain # Show AI reasoning
jira-to-pr PROJ-123 --yes     # Skip confirmation

jira-to-pr list               # List available tickets
jira-to-pr config             # Show current config
```

### Interactive Mode

After generating code, you'll see a menu:

```
? What would you like to do?
❯ Apply changes and create PR
  Explain - show AI reasoning
  Retry - regenerate with feedback
  Abort
```

Select "Retry" to give feedback and regenerate the code.

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
- Interactive confirmation with explain/retry options

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
