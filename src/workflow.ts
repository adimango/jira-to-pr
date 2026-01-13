import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import { select, confirm, input } from '@inquirer/prompts';
import type {
  Config,
  JiraTicket,
  CodeGenerationResult,
  SafetyCheckResult,
  WorkflowOptions,
  FileChange,
} from './types.js';
import { JiraClient } from './jira.js';
import { GitHubClient } from './github.js';
import { AIClient } from './ai.js';
import { ThinkingIndicator } from './ui.js';
import { displayAllDiffs } from './diff.js';
import { createFileOperations, type FileOperations } from './file-operations.js';
import { validateTestCoverage } from './validation.js';

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
      await this.checkReadiness(spinner, fileOps, options);

      // Step 3: Gather repository context
      const context = await this.gatherContext(spinner, fileOps, ticket, options);

      // Step 4: Generate code (with retry loop for interactive mode)
      let result = await this.generateCode(ticket, context);

      // Step 5: Safety checks
      const safetyResult = this.runSafetyChecks(spinner, result, context.files, options);
      if (!safetyResult.passed) {
        return;
      }

      // Step 6: Display diff preview and explanation
      await displayAllDiffs(result.changes, (path) => fileOps.readFile(path));
      this.displayChangeList(result.changes);
      this.displayGitInfo(result);

      if (options.explain) {
        this.displayExplanation(result);
      }

      // Step 7: Dry-run exit
      if (options.dryRun) {
        console.log(chalk.yellow('\n[DRY RUN] No changes will be applied.'));
        return;
      }

      // Step 8: Interactive confirmation (or auto-approve)
      if (options.autoApprove) {
        // Skip interactive mode - apply directly
        await this.applyChangesAndCreatePR(spinner, fileOps, result, false);
        return;
      }

      // For remote mode, use simpler flow (no local review)
      if (!fileOps.supportsLocalReview()) {
        const confirm = await this.promptSimpleConfirm();
        if (!confirm) {
          console.log(chalk.yellow('Aborted by user.'));
          return;
        }
        await this.applyChangesAndCreatePR(spinner, fileOps, result, false);
        return;
      }

      // Local mode: Two-stage interactive flow
      let changesApplied = false;

      // Pre-apply loop
      while (true) {
        const preAction = await this.promptPreApply();

        if (preAction === 'abort') {
          if (changesApplied) {
            await fileOps.discardChanges(result.changes);
            console.log(chalk.dim('Changes discarded.'));
          }
          console.log(chalk.yellow('Aborted by user.'));
          return;
        }

        if (preAction === 'explain') {
          this.displayExplanation(result);
          continue; // Show menu again
        }

        if (preAction === 'retry') {
          if (changesApplied) {
            await fileOps.discardChanges(result.changes);
            changesApplied = false;
          }
          const feedback = await this.promptRetryFeedback();
          result = await this.regenerateWithFeedback(spinner, ticket, context, result, feedback);
          await displayAllDiffs(result.changes, (path) => fileOps.readFile(path));
          this.displayChangeList(result.changes);
          this.displayGitInfo(result);
          continue; // Show menu again
        }

        if (preAction === 'direct') {
          // Skip local review, create PR directly
          await this.applyChangesAndCreatePR(spinner, fileOps, result, false);
          return;
        }

        if (preAction === 'apply') {
          // Apply changes locally
          spinner.start('Applying changes locally...');
          await fileOps.applyChangesLocally(result.changes);
          spinner.succeed('Changes applied locally');
          changesApplied = true;

          this.displayLocalReviewInstructions();

          // Post-apply loop
          while (true) {
            const postAction = await this.promptPostApply();

            if (postAction === 'discard') {
              spinner.start('Discarding changes...');
              await fileOps.discardChanges(result.changes);
              spinner.succeed('Changes discarded');
              console.log(chalk.yellow('Aborted by user.'));
              return;
            }

            if (postAction === 'retry') {
              spinner.start('Discarding changes...');
              await fileOps.discardChanges(result.changes);
              spinner.succeed('Changes discarded');
              changesApplied = false;
              const feedback = await this.promptRetryFeedback();
              result = await this.regenerateWithFeedback(spinner, ticket, context, result, feedback);
              await displayAllDiffs(result.changes, (path) => fileOps.readFile(path));
              this.displayChangeList(result.changes);
              this.displayGitInfo(result);
              break; // Go back to pre-apply menu
            }

            if (postAction === 'commit') {
              // Check if developer made manual modifications
              const wasModified = await this.checkForManualModifications(
                result.changes,
                (path) => fileOps.readFile(path)
              );

              // Update PR body with AI notice
              result.prBody = this.addAIGeneratedNotice(result.prBody, wasModified);

              // Create branch, commit, push, and create PR
              await this.createBranchCommitAndPR(spinner, fileOps, result, wasModified);
              return;
            }
          }
        }
      }
    } catch (error) {
      spinner.fail('Workflow failed');
      throw error;
    }
  }

  // ==================== INTERACTIVE METHODS ====================

  private async promptPreApply(): Promise<'apply' | 'direct' | 'abort' | 'explain' | 'retry'> {
    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { name: 'Apply locally - review and test before committing', value: 'apply' as const },
        { name: 'Create PR directly - skip local review', value: 'direct' as const },
        { name: 'Explain - show AI reasoning', value: 'explain' as const },
        { name: 'Retry - regenerate with feedback', value: 'retry' as const },
        { name: 'Abort', value: 'abort' as const },
      ],
      default: 'apply',
    });
    return action;
  }

  private async promptPostApply(): Promise<'commit' | 'discard' | 'retry'> {
    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { name: 'Commit & Create PR', value: 'commit' as const },
        { name: 'Discard changes - restore original files', value: 'discard' as const },
        { name: 'Retry - discard and regenerate with feedback', value: 'retry' as const },
      ],
      default: 'commit',
    });
    return action;
  }

  private async promptSimpleConfirm(): Promise<boolean> {
    const proceed = await confirm({
      message: 'Apply these changes and create a PR?',
      default: false,
    });
    return proceed;
  }

  private async promptRetryFeedback(): Promise<string> {
    const feedback = await input({
      message: 'What should be different? (e.g., "use a different approach for X"):',
    });
    return feedback;
  }

  private displayExplanation(result: CodeGenerationResult): void {
    console.log(chalk.bold('\nAI Reasoning:'));
    console.log(chalk.cyan('─'.repeat(60)));
    console.log(result.explanation);
    console.log(chalk.cyan('─'.repeat(60)));
    console.log();
  }

  private displayLocalReviewInstructions(): void {
    console.log(chalk.green('\n✓ Changes applied locally'));
    console.log(chalk.cyan('─'.repeat(60)));
    console.log(chalk.bold('You can now:'));
    console.log('  • Run your test suite');
    console.log('  • Start the application locally');
    console.log('  • Review the changes in your editor');
    console.log('  • Make manual adjustments if needed');
    console.log(chalk.cyan('─'.repeat(60)));
    console.log(chalk.dim('When you\'re done reviewing, select an option below.\n'));
  }

  private async checkForManualModifications(
    changes: FileChange[],
    readFile: (path: string) => Promise<string | null>
  ): Promise<boolean> {
    for (const change of changes) {
      if (change.operation === 'delete') {
        continue; // Can't modify a deleted file
      }
      const currentContent = await readFile(change.path);
      if (currentContent !== change.content) {
        return true; // File was modified
      }
    }
    return false;
  }

  private addAIGeneratedNotice(prBody: string, _wasModified: boolean): string {
    const notice = '\n\n---\n🤖 *AI-generated code - please review carefully*';
    return prBody + notice;
  }

  private async regenerateWithFeedback(
    _spinner: Ora,
    ticket: JiraTicket,
    context: {
      files: string[];
      relevantFileContents: Map<string, string>;
      projectInstructions: { content: string; file: string } | null;
      prTemplate: string | null;
    },
    previousResult: CodeGenerationResult,
    feedback: string
  ): Promise<CodeGenerationResult> {
    const thinking = new ThinkingIndicator();
    thinking.start('Regenerating with feedback');

    const repoInfo = await this.github.getRepoInfo();

    try {
      const result = await this.ai.regenerateWithFeedback(
        ticket,
        {
          files: context.files,
          relevantFileContents: context.relevantFileContents,
          language: repoInfo.language,
          projectInstructions: context.projectInstructions,
          prTemplate: context.prTemplate,
        },
        previousResult,
        feedback,
        (token) => thinking.onToken(token)
      );
      thinking.succeed('Code regenerated');
      return result;
    } catch (error) {
      thinking.fail('Regeneration failed');
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
          'Use --ticket to specify a single ticket.'
      );
    }

    const ticket = tickets[0];
    this.displayTicket(ticket);

    if (this.config.safety.requireAcceptanceCriteria && !ticket.acceptanceCriteria) {
      throw new Error(this.formatMissingACError(ticket.key));
    }

    return ticket;
  }

  private formatMissingACError(ticketKey: string): string {
    return `Ticket ${ticketKey} has no acceptance criteria.

Acceptance criteria help the AI understand what "done" looks like.

Example of good acceptance criteria:
  - When user clicks "Submit", form data is saved to the database
  - If email is invalid, show error message "Please enter a valid email"
  - Loading spinner appears while request is in progress
  - Success message appears after save completes

Add acceptance criteria to the Jira ticket, then try again.`;
  }

  private async checkReadiness(
    spinner: Ora,
    fileOps: FileOperations,
    options: WorkflowOptions
  ): Promise<void> {
    if (options.remote) {
      console.log(chalk.dim('  Running in remote mode (no local git)'));
      return;
    }

    // Ensure config files are in .gitignore before any git operations
    const addedToGitignore = await this.github.ensureConfigInGitignore();
    if (addedToGitignore.length > 0) {
      console.log(chalk.dim(`  Added to .gitignore: ${addedToGitignore.join(', ')}`));
    }

    if (options.allowDirty) {
      console.log(chalk.dim('  Skipping clean working tree check (--allow-dirty)'));
      return;
    }

    spinner.start('Checking git status...');
    const { ready, message } = await fileOps.checkReady();
    if (!ready) {
      spinner.fail('Working tree is not clean');
      throw new Error(
        (message || 'Working tree is not clean') +
          '\nCommit or stash changes first, or use --allow-dirty to proceed anyway.'
      );
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

  private runSafetyChecks(
    spinner: Ora,
    result: CodeGenerationResult,
    allFiles: string[],
    options: WorkflowOptions
  ): SafetyCheckResult {
    spinner.start('Running safety checks...');

    const errors: string[] = [];
    const warnings: string[] = [];

    // Check number of files
    if (result.changes.length > this.config.safety.maxFilesToChange) {
      if (options.allowLargeDiff) {
        warnings.push(
          `File count (${result.changes.length}) exceeds limit - allowed by --allow-large-diff`
        );
      } else {
        errors.push(
          `Too many files: ${result.changes.length} > ${this.config.safety.maxFilesToChange}. ` +
            'Use --allow-large-diff to override.'
        );
      }
    }

    // Check total lines changed
    let totalLines = 0;
    for (const change of result.changes) {
      if (change.content) {
        totalLines += change.content.split('\n').length;
      }
    }

    if (totalLines > this.config.safety.maxLinesChanged) {
      if (options.allowLargeDiff) {
        warnings.push(
          `Lines changed (${totalLines}) exceeds limit - allowed by --allow-large-diff`
        );
      } else {
        errors.push(
          `Too many lines: ${totalLines} > ${this.config.safety.maxLinesChanged}. ` +
            'Use --allow-large-diff to override.'
        );
      }
    }

    // Path validation
    const forbiddenFiles = ['.jira-to-pr.env', '.jira-to-pr.json'];
    for (const change of result.changes) {
      const fileName = change.path.split('/').pop() || change.path;
      if (forbiddenFiles.includes(fileName)) {
        errors.push(`Forbidden file cannot be committed: ${change.path}`);
      }
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
        warnings.push(`Sensitive file: ${change.path}`);
      }
    }

    // Test coverage (advisory only)
    if (!options.allowMissingTests) {
      const testWarnings = validateTestCoverage(result.changes, allFiles);
      warnings.push(...testWarnings);
    }

    const passed = errors.length === 0;

    if (passed) {
      spinner.succeed('Safety checks passed');
    } else {
      spinner.fail('Safety checks failed');
      for (const error of errors) {
        console.log(chalk.red(`  ✗ ${error}`));
      }
    }

    for (const warning of warnings) {
      console.log(chalk.yellow(`  ⚠ ${warning}`));
    }

    return { passed, errors, warnings };
  }

  private displayGitInfo(result: CodeGenerationResult): void {
    console.log(chalk.bold('\nGit Operations:'));
    console.log(chalk.dim(`   Branch: ${result.branchName}`));
    console.log(chalk.dim(`   Commit: ${result.commitMessage}`));
    console.log(chalk.dim(`   PR: ${result.prTitle}`));
  }

  private displayChangeList(changes: FileChange[]): void {
    for (const change of changes) {
      const icon = change.operation === 'create' ? '+' : change.operation === 'delete' ? '-' : '~';
      const color = change.operation === 'create' ? chalk.green : change.operation === 'delete' ? chalk.red : chalk.yellow;
      console.log(color(`   ${icon} ${change.path} (${change.operation})`));
    }
  }

  private async applyChangesAndCreatePR(
    spinner: Ora,
    fileOps: FileOperations,
    result: CodeGenerationResult,
    wasModified: boolean
  ): Promise<void> {
    // Add AI notice to PR body
    const prBody = this.addAIGeneratedNotice(result.prBody, wasModified);

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
      body: prBody,
      head: result.branchName,
    });
    spinner.succeed('Pull request created');

    console.log(chalk.green(`\n✓ Created PR #${pr.number}`));
    console.log(chalk.blue(`  ${pr.url}`));
  }

  private async createBranchCommitAndPR(
    spinner: Ora,
    fileOps: FileOperations,
    result: CodeGenerationResult,
    wasModified: boolean
  ): Promise<void> {
    // Changes are already applied locally, just need to commit
    spinner.start('Creating branch...');
    await fileOps.createBranch(result.branchName);
    spinner.succeed(`Created branch: ${result.branchName}`);

    spinner.start('Committing and pushing changes...');
    await fileOps.commitAndPush(result.branchName, result.commitMessage);
    spinner.succeed(`Committed ${result.changes.length} file changes`);

    spinner.start('Creating pull request...');
    const pr = await this.github.createPullRequest({
      title: result.prTitle,
      body: result.prBody,
      head: result.branchName,
    });
    spinner.succeed('Pull request created');

    if (wasModified) {
      console.log(chalk.cyan('\n📝 Manual modifications detected - noted in PR'));
    }

    console.log(chalk.green(`\n✓ Created PR #${pr.number}`));
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
    console.log(chalk.bold(`\n${ticket.key}: ${ticket.summary}`));
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
}
