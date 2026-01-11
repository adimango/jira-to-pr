import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig, validateConfig } from './config.js';
import { JiraClient } from './jira.js';
import { Workflow } from './workflow.js';

export async function runMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'jira-to-pr',
    version: '1.0.0',
  });

  // Load and validate config once
  const config = loadConfig();
  const validation = validateConfig(config);

  if (!validation.valid) {
    console.error('Configuration errors:', validation.errors.join(', '));
    process.exit(1);
  }

  const jira = new JiraClient(config.jira);

  // Tool: list_tickets
  server.registerTool(
    'list_tickets',
    {
      description: 'List available Jira tickets from the configured project',
      inputSchema: {
        jql: z.string().optional().describe('Optional JQL query to filter tickets'),
        limit: z.number().optional().default(10).describe('Maximum number of tickets to return'),
      },
    },
    async ({ jql, limit }) => {
      const tickets = await jira.searchTickets(jql);
      const limited = tickets.slice(0, limit ?? 10);

      const ticketList = limited.map(t => ({
        key: t.key,
        summary: t.summary,
        status: t.status,
        type: t.issueType,
        priority: t.priority,
        hasAcceptanceCriteria: !!t.acceptanceCriteria,
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(ticketList, null, 2),
          },
        ],
      };
    }
  );

  // Tool: get_ticket
  server.registerTool(
    'get_ticket',
    {
      description: 'Get detailed information about a specific Jira ticket',
      inputSchema: {
        ticketKey: z.string().describe('The Jira ticket key (e.g., PROJ-123)'),
      },
    },
    async ({ ticketKey }) => {
      const ticket = await jira.getTicket(ticketKey);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              key: ticket.key,
              summary: ticket.summary,
              description: ticket.description,
              acceptanceCriteria: ticket.acceptanceCriteria,
              status: ticket.status,
              type: ticket.issueType,
              priority: ticket.priority,
              labels: ticket.labels,
              components: ticket.components,
            }, null, 2),
          },
        ],
      };
    }
  );

  // Tool: create_pr
  server.registerTool(
    'create_pr',
    {
      description: 'Generate code changes and create a GitHub PR from a Jira ticket. Use dryRun=true to preview changes first.',
      inputSchema: {
        ticketKey: z.string().describe('The Jira ticket key (e.g., PROJ-123)'),
        dryRun: z.boolean().optional().default(true).describe('If true, only preview changes without creating PR'),
      },
    },
    async ({ ticketKey, dryRun }) => {
      const workflow = new Workflow(config);

      // Capture output instead of printing to console
      const output: string[] = [];
      const originalLog = console.log;
      const originalError = console.error;

      console.log = (...args) => output.push(args.join(' '));
      console.error = (...args) => output.push(`ERROR: ${args.join(' ')}`);

      try {
        await workflow.run({
          ticketKey,
          dryRun: dryRun ?? true,
          autoApprove: !dryRun,
          verbose: false,
          remote: false,
          explain: false,
          allowDirty: true, // Allow in MCP context
          allowLargeDiff: false,
          allowMissingTests: true, // Don't warn in MCP context
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: output.join('\n'),
            },
          ],
        };
      } finally {
        console.log = originalLog;
        console.error = originalError;
      }
    }
  );

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
