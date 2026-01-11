export type AIProvider = 'anthropic' | 'openai' | 'ollama';

export interface Config {
  jira: {
    baseUrl: string;
    email: string;
    apiToken: string;
    projectKey: string;
    labelFilter?: string;
  };
  github: {
    token: string;
    owner: string;
    repo: string;
    baseBranch: string;
  };
  ai: {
    provider: AIProvider;
    apiKey?: string;
    model: string;
    baseUrl?: string; // For Ollama or custom endpoints
  };
  safety: {
    maxFilesToChange: number;
    maxLinesChanged: number;
    requireAcceptanceCriteria: boolean;
    requireSingleTicket: boolean;
  };
}

export interface JiraTicket {
  key: string;
  summary: string;
  description: string | null;
  acceptanceCriteria: string | null;
  status: string;
  assignee: string | null;
  labels: string[];
  issueType: string;
  priority: string;
  components: string[];
}

export interface FileChange {
  path: string;
  content: string;
  operation: 'create' | 'modify' | 'delete';
  originalContent?: string;
}

export interface CodeGenerationResult {
  changes: FileChange[];
  explanation: string;
  branchName: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
}

export interface SafetyCheckResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

export interface WorkflowOptions {
  dryRun: boolean;
  verbose: boolean;
  ticketKey?: string;
  jql?: string;
  autoApprove: boolean;
  remote: boolean; // Use GitHub API only, no local git required
  explain: boolean; // Show AI reasoning after generating code
  // Granular override flags
  allowDirty: boolean; // Allow uncommitted changes in working tree
  allowLargeDiff: boolean; // Allow diffs exceeding max limits
  allowMissingTests: boolean; // Allow changes without test updates
}
