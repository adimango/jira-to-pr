#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, validateConfig } from './config.js';
import { Workflow } from './workflow.js';
import { JiraClient } from './jira.js';
import { runInit } from './init.js';
import { runMcpServer } from './mcp.js';
import type { WorkflowOptions } from './types.js';

const program = new Command();

program
  .name('jira-to-pr')
  .description('Uses an AI model to generate minimal code changes from a Jira ticket.')
  .version('1.0.0');

program
  .command('run')
  .description('Fetch a Jira ticket and generate a PR')
  .argument('[ticket]', 'Jira ticket key (e.g., PROJ-123)')
  .option('-t, --ticket <key>', 'Specific Jira ticket key (e.g., PROJ-123)')
  .option('-q, --jql <query>', 'Custom JQL query to find tickets')
  .option('-d, --dry-run', 'Preview changes without applying them', false)
  .option('-y, --yes', 'Auto-approve changes without prompting', false)
  .option('-v, --verbose', 'Show detailed output', false)
  .option('-r, --remote', 'Use GitHub API only (no local git required)', false)
  .option('-e, --explain', 'Show AI reasoning for the generated changes', false)
  .option('--allow-dirty', 'Allow uncommitted changes in working tree', false)
  .option('--allow-large-diff', 'Allow diffs exceeding safety limits', false)
  .option('--allow-missing-tests', 'Suppress test coverage warnings', false)
  .action(async (ticketArg, options) => {
    try {
      const config = loadConfig();
      const validation = validateConfig(config);

      if (!validation.valid) {
        console.error(chalk.red('Configuration errors:'));
        for (const error of validation.errors) {
          console.error(chalk.red(`  - ${error}`));
        }
        console.error(chalk.dim('\nRun `jira-to-pr init` to create a .jira-to-pr.env config file.'));
        process.exit(1);
      }

      // Ticket can be provided as argument or option (argument takes precedence)
      const ticketKey = ticketArg || options.ticket;

      const workflowOptions: WorkflowOptions = {
        ticketKey,
        jql: options.jql,
        dryRun: options.dryRun,
        autoApprove: options.yes,
        verbose: options.verbose,
        remote: options.remote,
        explain: options.explain,
        allowDirty: options.allowDirty,
        allowLargeDiff: options.allowLargeDiff,
        allowMissingTests: options.allowMissingTests,
      };

      const workflow = new Workflow(config);
      await workflow.run(workflowOptions);
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : 'Unknown error'}`));
      if (options.verbose && error instanceof Error && error.stack) {
        console.error(chalk.dim(error.stack));
      }
      process.exit(1);
    }
  });

program
  .command('list')
  .description('List available Jira tickets')
  .option('-q, --jql <query>', 'Custom JQL query')
  .option('-n, --limit <number>', 'Maximum number of tickets to show', '10')
  .action(async (options) => {
    try {
      const config = loadConfig();
      const validation = validateConfig(config);

      if (!validation.valid) {
        console.error(chalk.red('Configuration errors:'));
        for (const error of validation.errors) {
          console.error(chalk.red(`  - ${error}`));
        }
        process.exit(1);
      }

      const jira = new JiraClient(config.jira);
      const tickets = await jira.searchTickets(options.jql);
      const limit = Number.parseInt(options.limit, 10);

      console.log(chalk.bold(`\nFound ${tickets.length} ticket(s):\n`));

      for (const ticket of tickets.slice(0, limit)) {
        const hasAC = ticket.acceptanceCriteria ? chalk.green('✓ AC') : chalk.yellow('✗ AC');
        console.log(`  ${chalk.cyan(ticket.key)} ${ticket.summary}`);
        console.log(chalk.dim(`    ${ticket.issueType} | ${ticket.priority} | ${ticket.status} | ${hasAC}`));
        console.log();
      }

      if (tickets.length > limit) {
        console.log(chalk.dim(`  ... and ${tickets.length - limit} more`));
      }
    } catch (error) {
      console.error(chalk.red(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`));
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Initialize configuration in current project')
  .action(async () => {
    try {
      await runInit();
    } catch (error) {
      console.error(chalk.red(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`));
      process.exit(1);
    }
  });

program
  .command('mcp')
  .description('Run as MCP server for Claude Code integration')
  .action(async () => {
    try {
      await runMcpServer();
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  });

program
  .command('config')
  .description('Show current configuration (redacted)')
  .action(() => {
    const config = loadConfig();

    console.log(chalk.bold('\nCurrent Configuration:\n'));

    console.log(chalk.cyan('Jira:'));
    console.log(`  Base URL: ${config.jira.baseUrl || chalk.dim('(not set)')}`);
    console.log(`  Email: ${config.jira.email || chalk.dim('(not set)')}`);
    console.log(`  API Token: ${config.jira.apiToken ? chalk.green('✓ set') : chalk.red('✗ not set')}`);
    console.log(`  Project Key: ${config.jira.projectKey || chalk.dim('(not set)')}`);
    console.log(`  Label Filter: ${config.jira.labelFilter || chalk.dim('(none)')}`);

    console.log(chalk.cyan('\nGitHub:'));
    console.log(`  Token: ${config.github.token ? chalk.green('✓ set') : chalk.red('✗ not set')}`);
    console.log(`  Owner: ${config.github.owner || chalk.dim('(not set)')}`);
    console.log(`  Repo: ${config.github.repo || chalk.dim('(not set)')}`);
    console.log(`  Base Branch: ${config.github.baseBranch}`);

    console.log(chalk.cyan('\nAI Provider:'));
    console.log(`  Provider: ${config.ai.provider}`);
    if (config.ai.provider !== 'ollama') {
      console.log(`  API Key: ${config.ai.apiKey ? chalk.green('✓ set') : chalk.red('✗ not set')}`);
    }
    console.log(`  Model: ${config.ai.model}`);
    if (config.ai.baseUrl) {
      console.log(`  Base URL: ${config.ai.baseUrl}`);
    }

    console.log(chalk.cyan('\nSafety:'));
    console.log(`  Max Files to Change: ${config.safety.maxFilesToChange}`);
    console.log(`  Max Lines Changed: ${config.safety.maxLinesChanged}`);
    console.log(`  Require AC: ${config.safety.requireAcceptanceCriteria}`);
    console.log(`  Require Single Ticket: ${config.safety.requireSingleTicket}`);
    console.log();
  });

// Default command - if argument looks like a ticket key, run it directly
program
  .argument('[ticket]', 'Jira ticket key (e.g., PROJ-123)')
  .option('-d, --dry-run', 'Preview changes without applying them', false)
  .option('-y, --yes', 'Auto-approve changes without prompting', false)
  .option('-v, --verbose', 'Show detailed output', false)
  .option('-r, --remote', 'Use GitHub API only (no local git required)', false)
  .option('-e, --explain', 'Show AI reasoning for the generated changes', false)
  .option('--allow-dirty', 'Allow uncommitted changes in working tree', false)
  .option('--allow-large-diff', 'Allow diffs exceeding safety limits', false)
  .option('--allow-missing-tests', 'Suppress test coverage warnings', false)
  .action(async (ticketArg, options) => {
    // If no ticket provided, show help
    if (!ticketArg) {
      program.help();
      return;
    }

    // Check if it looks like a ticket key (e.g., PROJ-123)
    if (!/^[A-Z]+-\d+$/i.test(ticketArg)) {
      console.error(chalk.red(`Invalid ticket key format: ${ticketArg}`));
      console.error(chalk.dim('Expected format: PROJ-123'));
      process.exit(1);
    }

    try {
      const config = loadConfig();
      const validation = validateConfig(config);

      if (!validation.valid) {
        console.error(chalk.red('Configuration errors:'));
        for (const error of validation.errors) {
          console.error(chalk.red(`  - ${error}`));
        }
        console.error(chalk.dim('\nRun `jira-to-pr init` to create a .jira-to-pr.env config file.'));
        process.exit(1);
      }

      const workflowOptions: WorkflowOptions = {
        ticketKey: ticketArg,
        dryRun: options.dryRun,
        autoApprove: options.yes,
        verbose: options.verbose,
        remote: options.remote,
        explain: options.explain,
        allowDirty: options.allowDirty,
        allowLargeDiff: options.allowLargeDiff,
        allowMissingTests: options.allowMissingTests,
      };

      const workflow = new Workflow(config);
      await workflow.run(workflowOptions);
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : 'Unknown error'}`));
      if (options.verbose && error instanceof Error && error.stack) {
        console.error(chalk.dim(error.stack));
      }
      process.exit(1);
    }
  });

program.parse();
