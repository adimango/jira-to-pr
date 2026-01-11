import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import inquirer from 'inquirer';
import type { Config, JiraTicket, CodeGenerationResult, SafetyCheckResult, WorkflowOptions } from './types.js';
import { JiraClient } from './jira.js';
import { GitHubClient } from './github.js';
import { AIClient } from './ai.js';
import { ThinkingIndicator } from './ui.js';
import { displayAllDiffs } from './diff.js';
import { createFileOperations, type FileOperations } from './file-operations.js';

export class Workflow {
  private jira: JiraClient;
  private github: GitHubClient;
  private ai: AIClient;
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    this.jira = new JiraClient(config.jira);
    this.github = new GitHubClient(config.github);
    this.ai = new AIClient(config.ai);
  }

  async run(options: WorkflowOptions): Promise<void> {
    const spinner = ora();
    const fileOps = createFileOperations(this.github, options.remote);

    try {
      // Step 1: Fetch ticket
      const ticket = await this.fetchAndValidateTicket(spinner, options);

      // Step 2: Check readiness
      await this.checkReadiness(spinner, fileOps, options.remote, options.force);

      // Step 3: Gather repository context
      const { files, relevantFileContents, projectInstructions, prTemplate } =
        await this.gatherContext(spinner, fileOps, ticket, options);

      // Step 4: Generate code
      const result = await this.generateCode(
        ticket,
        { files, relevantFileContents, projectInstructions, prTemplate }
      );

      // Step 5: Safety checks
      this.validateSafety(spinner, result);

      // Step 6: Display diff preview
      await displayAllDiffs(result.changes, (path) => fileOps.readFile(path));
      this.displayGitInfo(result);

      // Step 7: Confirm or dry-run
      if (options.dryRun) {
        console.log(chalk.yellow('\n[DRY RUN] No changes will be applied.'));
        return;
      }

      if (!options.autoApprove && !(await this.confirmChanges())) {
        console.log(chalk.yellow('Aborted by user.'));
        return;
      }

      // Step 8: Apply changes and create PR
      await this.applyChangesAndCreatePR(spinner, fileOps, result);
    } catch (error) {
      spinner.fail('Workflow failed');
      throw error;
    }
  }

  // ==================== STEP METHODS ====================

  private async fetchAndValidateTicket(
    spinner: Ora,
    options: WorkflowOptions
  ): Promise<JiraTicket> {
    spinner.start('Fetching Jira ticket(s)...');
    const tickets = await this.fetchTickets(options);
    spinner.succeed(`Found ${tickets.length} ticket(s)`);

    if (this.config.safety.requireSingleTicket && tickets.length !== 1) {
      throw new Error(
        `Expected exactly 1 ticket, found ${tickets.length}. ` +
          'Use --ticket-key to specify a single ticket or disable requireSingleTicket in config.'
      );
    }

    const ticket = tickets[0];
    this.displayTicket(ticket);

    if (this.config.safety.requireAcceptanceCriteria && !ticket.acceptanceCriteria) {
      throw new Error(
        `Ticket ${ticket.key} has no acceptance criteria. ` +
          'Please add acceptance criteria or disable requireAcceptanceCriteria in config.'
      );
    }

    return ticket;
  }

  private async checkReadiness(
    spinner: Ora,
    fileOps: FileOperations,
    isRemote: boolean,
    force: boolean
  ): Promise<void> {
    if (isRemote) {
      console.log(chalk.dim('  Running in remote mode (no local git)'));
      return;
    }

    if (force) {
      console.log(chalk.dim('  Skipping clean working tree check (--force)'));
      return;
    }

    spinner.start('Checking git status...');
    const { ready, message } = await fileOps.checkReady();
    if (!ready) {
      spinner.fail('Working tree is not clean');
      throw new Error(message || 'Working tree is not clean');
    }
    spinner.succeed('Working tree is clean');
  }

  private async gatherContext(
    spinner: Ora,
    fileOps: FileOperations,
    ticket: JiraTicket,
    options: WorkflowOptions
  ): Promise<{
    files: string[];
    relevantFileContents: Map<string, string>;
    projectInstructions: { content: string; file: string } | null;
    prTemplate: string | null;
  }> {
    spinner.start('Analyzing repository structure...');
    const files = await fileOps.getFiles();

    spinner.text = 'Identifying relevant files...';
    const relevantFilePaths = await this.ai.identifyRelevantFiles(ticket, files);
    const relevantFileContents = new Map<string, string>();

    for (const filePath of relevantFilePaths) {
      const content = await fileOps.readFile(filePath);
      if (content) {
        relevantFileContents.set(filePath, content);
      }
    }
    spinner.succeed(`Analyzed ${files.length} files, ${relevantFilePaths.length} relevant`);

    const projectInstructions = options.remote ? null : this.ai.loadProjectInstructions();
    const prTemplate = await fileOps.getPRTemplate();

    if (projectInstructions) {
      console.log(chalk.dim(`  Found project instructions: ${projectInstructions.file}`));
    }
    if (prTemplate) {
      console.log(chalk.dim('  Found PR template'));
    }

    if (options.verbose) {
      console.log(chalk.dim('Relevant files:'));
      for (const path of relevantFilePaths) {
        console.log(chalk.dim(`  - ${path}`));
      }
    }

    return { files, relevantFileContents, projectInstructions, prTemplate };
  }

  private async generateCode(
    ticket: JiraTicket,
    context: {
      files: string[];
      relevantFileContents: Map<string, string>;
      projectInstructions: { content: string; file: string } | null;
      prTemplate: string | null;
    }
  ): Promise<CodeGenerationResult> {
    const thinking = new ThinkingIndicator();
    thinking.start('Generating code with AI');

    const repoInfo = await this.github.getRepoInfo();

    try {
      const result = await this.ai.generateCode(
        ticket,
        {
          files: context.files,
          relevantFileContents: context.relevantFileContents,
          language: repoInfo.language,
          projectInstructions: context.projectInstructions,
          prTemplate: context.prTemplate,
        },
        (token) => thinking.onToken(token)
      );
      thinking.succeed('Code generated');
      return result;
    } catch (error) {
      thinking.fail('Code generation failed');
      throw error;
    }
  }

  private validateSafety(spinner: Ora, result: CodeGenerationResult): void {
    spinner.start('Running safety checks...');
    const safetyResult = this.runSafetyChecks(result);

    if (!safetyResult.passed) {
      spinner.fail('Safety checks failed');
      for (const error of safetyResult.errors) {
        console.log(chalk.red(`  ✗ ${error}`));
      }
      throw new Error('Safety checks failed. Aborting.');
    }
    spinner.succeed('Safety checks passed');

    for (const warning of safetyResult.warnings) {
      console.log(chalk.yellow(`  ⚠ ${warning}`));
    }
  }

  private displayGitInfo(result: CodeGenerationResult): void {
    console.log(chalk.bold('\n🔀 Git Operations:'));
    console.log(chalk.dim(`   Branch: ${result.branchName}`));
    console.log(chalk.dim(`   Commit: ${result.commitMessage}`));
    console.log(chalk.dim(`   PR: ${result.prTitle}`));
  }

  private async confirmChanges(): Promise<boolean> {
    const { proceed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'proceed',
        message: 'Do you want to apply these changes and create a PR?',
        default: false,
      },
    ]);
    return proceed;
  }

  private async applyChangesAndCreatePR(
    spinner: Ora,
    fileOps: FileOperations,
    result: CodeGenerationResult
  ): Promise<void> {
    spinner.start('Creating branch...');
    await fileOps.createBranch(result.branchName);
    spinner.succeed(`Created branch: ${result.branchName}`);

    spinner.start('Committing changes...');
    await fileOps.applyChangesAndCommit(
      result.branchName,
      result.changes,
      result.commitMessage
    );
    spinner.succeed(`Committed ${result.changes.length} file changes`);

    spinner.start('Creating pull request...');
    const pr = await this.github.createPullRequest({
      title: result.prTitle,
      body: result.prBody,
      head: result.branchName,
    });
    spinner.succeed('Pull request created');

    console.log(chalk.green(`\n✓ Successfully created PR #${pr.number}`));
    console.log(chalk.blue(`  ${pr.url}`));
  }

  private async fetchTickets(options: WorkflowOptions): Promise<JiraTicket[]> {
    if (options.ticketKey) {
      const ticket = await this.jira.getTicket(options.ticketKey);
      return [ticket];
    }

    return this.jira.searchTickets(options.jql);
  }

  private displayTicket(ticket: JiraTicket): void {
    console.log(chalk.bold(`\n📋 ${ticket.key}: ${ticket.summary}`));
    console.log(chalk.dim(`   Type: ${ticket.issueType} | Priority: ${ticket.priority} | Status: ${ticket.status}`));

    if (ticket.description) {
      console.log(chalk.dim('\n   Description:'));
      const lines = ticket.description.split('\n').slice(0, 5);
      for (const line of lines) {
        console.log(chalk.dim(`   ${line}`));
      }
      if (ticket.description.split('\n').length > 5) {
        console.log(chalk.dim('   ...'));
      }
    }

    if (ticket.acceptanceCriteria) {
      console.log(chalk.dim('\n   Acceptance Criteria:'));
      const lines = ticket.acceptanceCriteria.split('\n').slice(0, 5);
      for (const line of lines) {
        console.log(chalk.dim(`   ${line}`));
      }
    }
    console.log();
  }

  private runSafetyChecks(result: CodeGenerationResult): SafetyCheckResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check number of files
    if (result.changes.length > this.config.safety.maxFilesToChange) {
      errors.push(
        `Too many files changed: ${result.changes.length} > ${this.config.safety.maxFilesToChange}`
      );
    }

    // Check total lines changed
    let totalLines = 0;
    for (const change of result.changes) {
      if (change.content) {
        totalLines += change.content.split('\n').length;
      }
    }

    if (totalLines > this.config.safety.maxLinesChanged) {
      errors.push(
        `Too many lines changed: ${totalLines} > ${this.config.safety.maxLinesChanged}`
      );
    }

    // Warn about certain patterns
    for (const change of result.changes) {
      if (change.path.includes('..')) {
        errors.push(`Suspicious path: ${change.path}`);
      }

      if (change.path.startsWith('/')) {
        errors.push(`Absolute path not allowed: ${change.path}`);
      }

      if (
        change.path.match(/\.(env|key|pem|secret|credential)/i) ||
        change.path.includes('password')
      ) {
        warnings.push(`Potentially sensitive file: ${change.path}`);
      }
    }

    return {
      passed: errors.length === 0,
      errors,
      warnings,
    };
  }
}
