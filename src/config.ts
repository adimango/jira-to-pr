import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import dotenv from 'dotenv';
import type { Config, AIProvider } from './types.js';

const CONFIG_FILE_NAME = '.jira-to-pr.json';
const ENV_FILE_NAME = '.jira-to-pr.env';

function findConfigFile(): string | null {
  // Check current directory
  const localConfig = resolve(process.cwd(), CONFIG_FILE_NAME);
  if (existsSync(localConfig)) {
    return localConfig;
  }

  // Check home directory
  const homeConfig = join(homedir(), CONFIG_FILE_NAME);
  if (existsSync(homeConfig)) {
    return homeConfig;
  }

  return null;
}

function findEnvFile(): string | null {
  // Check current directory
  const localEnv = resolve(process.cwd(), ENV_FILE_NAME);
  if (existsSync(localEnv)) {
    return localEnv;
  }

  // Check home directory
  const homeEnv = join(homedir(), ENV_FILE_NAME);
  if (existsSync(homeEnv)) {
    return homeEnv;
  }

  return null;
}

function detectProvider(): AIProvider {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.OLLAMA_MODEL || process.env.OLLAMA_BASE_URL) return 'ollama';
  return 'anthropic'; // default
}

function getApiKey(provider: AIProvider): string {
  switch (provider) {
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY || '';
    case 'openai':
      return process.env.OPENAI_API_KEY || '';
    case 'ollama':
      return ''; // Ollama doesn't need API key
  }
}

function getDefaultModel(provider: AIProvider): string {
  switch (provider) {
    case 'anthropic':
      return process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
    case 'openai':
      return process.env.OPENAI_MODEL || 'gpt-4o';
    case 'ollama':
      return process.env.OLLAMA_MODEL || 'llama3.1';
  }
}

function loadEnvConfig(): Partial<Config> {
  // Load from .jira-to-pr.env (project-specific, won't conflict with project's .env)
  const envFile = findEnvFile();
  if (envFile) {
    dotenv.config({ path: envFile });
  }

  const provider = (process.env.AI_PROVIDER as AIProvider) || detectProvider();

  return {
    jira: {
      baseUrl: process.env.JIRA_BASE_URL || '',
      email: process.env.JIRA_EMAIL || '',
      apiToken: process.env.JIRA_API_TOKEN || '',
      projectKey: process.env.JIRA_PROJECT_KEY || '',
      labelFilter: process.env.JIRA_LABEL_FILTER,
    },
    github: {
      token: process.env.GITHUB_TOKEN || '',
      owner: process.env.GITHUB_OWNER || '',
      repo: process.env.GITHUB_REPO || '',
      baseBranch: process.env.GITHUB_BASE_BRANCH || 'main',
    },
    ai: {
      provider,
      apiKey: getApiKey(provider),
      model: getDefaultModel(provider),
      baseUrl: process.env.OLLAMA_BASE_URL || process.env.OPENAI_BASE_URL,
    },
    safety: {
      maxFilesToChange: Number.parseInt(process.env.MAX_FILES_TO_CHANGE || '10', 10),
      maxLinesChanged: Number.parseInt(process.env.MAX_LINES_CHANGED || '500', 10),
      requireAcceptanceCriteria: process.env.REQUIRE_ACCEPTANCE_CRITERIA !== 'false',
      requireSingleTicket: process.env.REQUIRE_SINGLE_TICKET !== 'false',
    },
  };
}

function loadFileConfig(): Partial<Config> {
  const configPath = findConfigFile();
  if (!configPath) {
    return {};
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    console.warn(`Warning: Failed to parse config file at ${configPath}`);
    return {};
  }
}

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (
      sourceValue !== undefined &&
      typeof sourceValue === 'object' &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(targetValue as object, sourceValue as object) as T[keyof T];
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[keyof T];
    }
  }

  return result;
}

export function loadConfig(): Config {
  const defaultConfig: Config = {
    jira: {
      baseUrl: '',
      email: '',
      apiToken: '',
      projectKey: '',
    },
    github: {
      token: '',
      owner: '',
      repo: '',
      baseBranch: 'main',
    },
    ai: {
      provider: 'anthropic',
      apiKey: '',
      model: 'claude-sonnet-4-20250514',
    },
    safety: {
      maxFilesToChange: 10,
      maxLinesChanged: 500,
      requireAcceptanceCriteria: true,
      requireSingleTicket: true,
    },
  };

  const fileConfig = loadFileConfig();
  const envConfig = loadEnvConfig();

  // File config takes precedence over defaults, env takes precedence over file
  let config = deepMerge(defaultConfig, fileConfig);
  config = deepMerge(config, envConfig);

  return config;
}

export function validateConfig(config: Config): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Jira validation
  if (!config.jira.baseUrl) errors.push('JIRA_BASE_URL is required');
  if (!config.jira.email) errors.push('JIRA_EMAIL is required');
  if (!config.jira.apiToken) errors.push('JIRA_API_TOKEN is required');
  if (!config.jira.projectKey) errors.push('JIRA_PROJECT_KEY is required');

  // GitHub validation
  if (!config.github.token) errors.push('GITHUB_TOKEN is required');
  if (!config.github.owner) errors.push('GITHUB_OWNER is required');
  if (!config.github.repo) errors.push('GITHUB_REPO is required');

  // AI validation - only require API key for non-Ollama providers
  if (config.ai.provider !== 'ollama' && !config.ai.apiKey) {
    const keyName = config.ai.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    errors.push(`${keyName} is required for ${config.ai.provider} provider`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
