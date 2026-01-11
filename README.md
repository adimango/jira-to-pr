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
jira-to-pr PROJ-123 --yes     # Skip confirmation
jira-to-pr PROJ-123 --force   # Allow uncommitted changes
jira-to-pr PROJ-123 --remote  # No local git needed

jira-to-pr list               # List available tickets
jira-to-pr config             # Show current config
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

- Requires acceptance criteria by default
- Limits files (10) and lines (500) changed
- Shows diff preview before applying
- Requires confirmation before creating PR

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
