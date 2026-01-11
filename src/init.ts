import chalk from 'chalk';

interface InitAnswers {
  jira: {
    baseUrl: string;
    email: string;
    apiToken: string;
    projectKey: string;
  };
  github: {
    token: string;
    owner: string;
    repo: string;
    baseBranch: string;
  };
  ai: {
    provider: 'anthropic' | 'openai' | 'ollama';
    anthropicApiKey?: string;
    openaiApiKey?: string;
    ollamaModel?: string;
  };
}

interface GitInfo {
  isGitRepo: boolean;
  detectedOwner: string;
  detectedRepo: string;
  detectedBranch: string;
}

const ENV_FILE_NAME = '.jira-to-pr.env';

/**
 * Detect GitHub info from local git remote
 */
async function detectGitInfo(): Promise<GitInfo> {
  const { simpleGit } = await import('simple-git');
  const git = simpleGit();

  const info: GitInfo = {
    isGitRepo: false,
    detectedOwner: '',
    detectedRepo: '',
    detectedBranch: 'main',
  };

  try {
    await git.status();
    info.isGitRepo = true;

    // Detect owner/repo from remote
    const remotes = await git.getRemotes(true);
    const origin = remotes.find(r => r.name === 'origin');
    if (origin?.refs?.fetch) {
      const match = origin.refs.fetch.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      if (match) {
        info.detectedOwner = match[1];
        info.detectedRepo = match[2];
      }
    }

    // Detect default branch
    const branches = await git.branch();
    if (branches.all.includes('main')) {
      info.detectedBranch = 'main';
    } else if (branches.all.includes('master')) {
      info.detectedBranch = 'master';
    }
  } catch {
    // Not a git repo or git not available
  }

  return info;
}

/**
 * Check if config file exists and prompt for overwrite
 */
async function checkExistingConfig(inquirer: any): Promise<boolean> {
  const fs = await import('node:fs/promises');

  try {
    await fs.access(ENV_FILE_NAME);
    const { overwrite } = await (inquirer as any).prompt([{
      type: 'confirm',
      name: 'overwrite',
      message: `${ENV_FILE_NAME} already exists. Overwrite?`,
      default: false,
    }]);
    return overwrite;
  } catch {
    return true; // File doesn't exist, proceed
  }
}

/**
 * Prompt for Jira configuration
 */
async function promptJiraConfig(inquirer: any): Promise<InitAnswers['jira']> {
  console.log(chalk.dim('\n  Step 1/3: Jira Configuration\n'));

  const answers = await (inquirer as any).prompt([
    {
      type: 'input',
      name: 'baseUrl',
      message: 'Jira base URL:',
      default: 'https://yourcompany.atlassian.net',
      validate: (v: string) => v.startsWith('http') || 'Must be a valid URL',
    },
    {
      type: 'input',
      name: 'email',
      message: 'Jira email:',
      validate: (v: string) => v.includes('@') || 'Must be a valid email',
    },
    {
      type: 'password',
      name: 'apiToken',
      message: 'Jira API token (from id.atlassian.com/manage-profile/security/api-tokens):',
      mask: '*',
    },
    {
      type: 'input',
      name: 'projectKey',
      message: 'Jira project key (e.g., PROJ):',
      validate: (v: string) => /^[A-Z]+$/i.test(v) || 'Must be letters only (e.g., PROJ)',
      transformer: (v: string) => v.toUpperCase(),
    },
  ]);

  return {
    baseUrl: answers.baseUrl,
    email: answers.email,
    apiToken: answers.apiToken,
    projectKey: answers.projectKey.toUpperCase(),
  };
}

/**
 * Prompt for GitHub configuration
 */
async function promptGitHubConfig(
  inquirer: any,
  gitInfo: GitInfo
): Promise<InitAnswers['github']> {
  console.log(chalk.dim('\n  Step 2/3: GitHub Configuration\n'));

  const answers = await (inquirer as any).prompt([
    {
      type: 'password',
      name: 'token',
      message: 'GitHub token (from github.com/settings/tokens):',
      mask: '*',
    },
    {
      type: 'input',
      name: 'owner',
      message: 'GitHub owner/organization:',
      default: gitInfo.detectedOwner || undefined,
      validate: (v: string) => v.length > 0 || 'Required',
    },
    {
      type: 'input',
      name: 'repo',
      message: 'GitHub repository name:',
      default: gitInfo.detectedRepo || undefined,
      validate: (v: string) => v.length > 0 || 'Required',
    },
    {
      type: 'input',
      name: 'baseBranch',
      message: 'Base branch:',
      default: gitInfo.detectedBranch,
    },
  ]);

  return answers;
}

/**
 * Prompt for AI provider configuration
 */
async function promptAIConfig(inquirer: any): Promise<InitAnswers['ai']> {
  console.log(chalk.dim('\n  Step 3/3: AI Provider\n'));

  const answers = await (inquirer as any).prompt([
    {
      type: 'list',
      name: 'provider',
      message: 'AI provider:',
      choices: [
        { name: 'Anthropic (Claude) - Recommended', value: 'anthropic' },
        { name: 'OpenAI (GPT-4)', value: 'openai' },
        { name: 'Ollama (Local)', value: 'ollama' },
      ],
      default: 'anthropic',
    },
    {
      type: 'password',
      name: 'anthropicApiKey',
      message: 'Anthropic API key (from console.anthropic.com):',
      mask: '*',
      when: (ans: { provider: string }) => ans.provider === 'anthropic',
    },
    {
      type: 'password',
      name: 'openaiApiKey',
      message: 'OpenAI API key:',
      mask: '*',
      when: (ans: { provider: string }) => ans.provider === 'openai',
    },
    {
      type: 'input',
      name: 'ollamaModel',
      message: 'Ollama model name:',
      default: 'llama3.1',
      when: (ans: { provider: string }) => ans.provider === 'ollama',
    },
  ]);

  return answers;
}

/**
 * Build the .env file content from answers
 */
function buildEnvContent(answers: InitAnswers): string {
  let content = `# jira-to-pr configuration
# File: ${ENV_FILE_NAME} (won't conflict with your project's .env)
# Generated by: jira-to-pr init

# Jira Configuration
JIRA_BASE_URL=${answers.jira.baseUrl}
JIRA_EMAIL=${answers.jira.email}
JIRA_API_TOKEN=${answers.jira.apiToken || 'your_jira_api_token_here'}
JIRA_PROJECT_KEY=${answers.jira.projectKey}

# GitHub Configuration
GITHUB_TOKEN=${answers.github.token || 'your_github_token_here'}
GITHUB_OWNER=${answers.github.owner}
GITHUB_REPO=${answers.github.repo}
GITHUB_BASE_BRANCH=${answers.github.baseBranch}

`;

  if (answers.ai.provider === 'anthropic') {
    content += `# Anthropic Configuration
ANTHROPIC_API_KEY=${answers.ai.anthropicApiKey || 'your_anthropic_api_key_here'}
# ANTHROPIC_MODEL=claude-sonnet-4-20250514
`;
  } else if (answers.ai.provider === 'openai') {
    content += `# OpenAI Configuration
OPENAI_API_KEY=${answers.ai.openaiApiKey || 'your_openai_api_key_here'}
# OPENAI_MODEL=gpt-4o
`;
  } else {
    content += `# Ollama Configuration (local)
OLLAMA_MODEL=${answers.ai.ollamaModel || 'llama3.1'}
# OLLAMA_BASE_URL=http://localhost:11434
`;
  }

  content += `
# Safety Configuration (optional)
# MAX_FILES_TO_CHANGE=10
# MAX_LINES_CHANGED=500
# REQUIRE_ACCEPTANCE_CRITERIA=true
# REQUIRE_SINGLE_TICKET=true
`;

  return content;
}

/**
 * Write config file and update .gitignore
 */
async function writeConfigFiles(content: string, isGitRepo: boolean): Promise<void> {
  const fs = await import('node:fs/promises');

  // Write config file
  await fs.writeFile(ENV_FILE_NAME, content);
  console.log(chalk.green(`\n✓ Created ${ENV_FILE_NAME}`));

  // Add to .gitignore if in a git repo
  if (isGitRepo) {
    try {
      let gitignore = '';
      try {
        gitignore = await fs.readFile('.gitignore', 'utf-8');
      } catch {
        // .gitignore doesn't exist
      }

      if (!gitignore.includes(ENV_FILE_NAME)) {
        const newGitignore = gitignore + (gitignore.endsWith('\n') ? '' : '\n') + ENV_FILE_NAME + '\n';
        await fs.writeFile('.gitignore', newGitignore);
        console.log(chalk.green(`✓ Added ${ENV_FILE_NAME} to .gitignore`));
      }
    } catch {
      console.log(chalk.yellow('⚠ Could not update .gitignore'));
    }
  }
}

/**
 * Display configuration summary
 */
function displaySummary(answers: InitAnswers): void {
  console.log(chalk.bold('\n📋 Configuration Summary:\n'));
  console.log(`  Jira:   ${answers.jira.baseUrl} (${answers.jira.projectKey})`);
  console.log(`  GitHub: ${answers.github.owner}/${answers.github.repo} (${answers.github.baseBranch})`);
  console.log(`  AI:     ${answers.ai.provider}`);
}

/**
 * Check for missing tokens and warn
 */
function checkMissingTokens(answers: InitAnswers): void {
  const missingTokens: string[] = [];

  if (!answers.jira.apiToken) missingTokens.push('JIRA_API_TOKEN');
  if (!answers.github.token) missingTokens.push('GITHUB_TOKEN');
  if (answers.ai.provider === 'anthropic' && !answers.ai.anthropicApiKey) {
    missingTokens.push('ANTHROPIC_API_KEY');
  }
  if (answers.ai.provider === 'openai' && !answers.ai.openaiApiKey) {
    missingTokens.push('OPENAI_API_KEY');
  }

  if (missingTokens.length > 0) {
    console.log(chalk.yellow(`\n⚠ Missing tokens: ${missingTokens.join(', ')}`));
    console.log(chalk.dim(`  Edit ${ENV_FILE_NAME} to add them before running.`));
  }
}

/**
 * Main init command handler
 */
export async function runInit(): Promise<void> {
  const inquirer = await import('inquirer');

  console.log(chalk.bold('\n🚀 Initializing jira-to-pr\n'));

  // Step 1: Detect git info
  const gitInfo = await detectGitInfo();

  if (!gitInfo.isGitRepo) {
    console.log(chalk.yellow('⚠ Not a git repository. Some features will be limited.\n'));
  } else if (gitInfo.detectedOwner && gitInfo.detectedRepo) {
    console.log(chalk.dim(`  Detected GitHub repo: ${gitInfo.detectedOwner}/${gitInfo.detectedRepo}`));
  }

  // Step 2: Check for existing config
  const shouldProceed = await checkExistingConfig(inquirer.default);
  if (!shouldProceed) {
    console.log(chalk.yellow(`\nAborted. Existing ${ENV_FILE_NAME} preserved.`));
    return;
  }

  // Step 3: Gather configuration
  const jiraConfig = await promptJiraConfig(inquirer.default);
  const githubConfig = await promptGitHubConfig(inquirer.default, gitInfo);
  const aiConfig = await promptAIConfig(inquirer.default);

  const answers: InitAnswers = {
    jira: jiraConfig,
    github: githubConfig,
    ai: aiConfig,
  };

  // Step 4: Write files
  const envContent = buildEnvContent(answers);
  await writeConfigFiles(envContent, gitInfo.isGitRepo);

  // Step 5: Display summary
  displaySummary(answers);
  checkMissingTokens(answers);

  console.log(chalk.bold('\n🎉 Setup complete!\n'));
  console.log(chalk.dim('  Try it out:'));
  console.log(chalk.cyan(`  jira-to-pr ${jiraConfig.projectKey}-123 --dry-run\n`));
}
