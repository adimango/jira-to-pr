import { Octokit } from '@octokit/rest';
import { simpleGit, SimpleGit } from 'simple-git';
import type { Config, FileChange } from './types.js';

export class GitHubClient {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private baseBranch: string;
  private git: SimpleGit;

  constructor(config: Config['github']) {
    this.octokit = new Octokit({ auth: config.token });
    this.owner = config.owner;
    this.repo = config.repo;
    this.baseBranch = config.baseBranch;
    this.git = simpleGit();
  }

  async getCurrentBranch(): Promise<string> {
    const result = await this.git.revparse(['--abbrev-ref', 'HEAD']);
    return result.trim();
  }

  async isWorkingTreeClean(): Promise<boolean> {
    const status = await this.git.status();

    // Files that jira-to-pr uses or modifies that should be ignored when checking cleanliness
    const ignoredFiles = ['.jira-to-pr.env', '.jira-to-pr.json', '.gitignore'];

    // Check if all changes are only in ignored files
    const allChangedFiles = [
      ...status.not_added,
      ...status.modified,
      ...status.deleted,
      ...status.created,
      ...status.staged,
    ];

    const relevantChanges = allChangedFiles.filter(
      file => !ignoredFiles.includes(file)
    );

    return relevantChanges.length === 0;
  }

  async createBranch(branchName: string): Promise<void> {
    // Ensure we're on the base branch and up to date
    await this.git.checkout(this.baseBranch);
    await this.git.pull('origin', this.baseBranch);

    // Create and checkout new branch
    await this.git.checkoutLocalBranch(branchName);
  }

  async applyChanges(changes: FileChange[]): Promise<void> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    for (const change of changes) {
      const filePath = path.resolve(process.cwd(), change.path);
      const dir = path.dirname(filePath);

      if (change.operation === 'delete') {
        await fs.unlink(filePath).catch(() => {});
      } else {
        // Ensure directory exists
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(filePath, change.content, 'utf-8');
      }
    }
  }

  async ensureConfigInGitignore(): Promise<string[]> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const gitignorePath = path.resolve(process.cwd(), '.gitignore');
    const filesToIgnore = ['.jira-to-pr.env', '.jira-to-pr.json'];
    const added: string[] = [];

    try {
      // Check if .gitignore exists
      let content = '';
      try {
        content = await fs.readFile(gitignorePath, 'utf-8');
      } catch {
        // .gitignore doesn't exist, create it
      }

      const lines = content.split('\n').map(line => line.trim());

      // Add missing files to .gitignore
      for (const file of filesToIgnore) {
        if (!lines.includes(file)) {
          content = content.endsWith('\n') || content === ''
            ? content + file + '\n'
            : content + '\n' + file + '\n';
          added.push(file);
        }
      }

      if (added.length > 0) {
        await fs.writeFile(gitignorePath, content, 'utf-8');
      }

      return added;
    } catch {
      return [];
    }
  }

  async commitChanges(message: string): Promise<void> {
    await this.git.add('.');
    await this.git.commit(message);
  }

  async pushBranch(branchName: string): Promise<void> {
    await this.git.push('origin', branchName, ['--set-upstream']);
  }

  async createPullRequest(options: {
    title: string;
    body: string;
    head: string;
    base?: string;
  }): Promise<{ url: string; number: number }> {
    const response = await this.octokit.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title: options.title,
      body: options.body,
      head: options.head,
      base: options.base || this.baseBranch,
    });

    return {
      url: response.data.html_url,
      number: response.data.number,
    };
  }

  async getRepoInfo(): Promise<{
    defaultBranch: string;
    size: number;
    language: string | null;
  }> {
    const response = await this.octokit.repos.get({
      owner: this.owner,
      repo: this.repo,
    });

    return {
      defaultBranch: response.data.default_branch,
      size: response.data.size,
      language: response.data.language,
    };
  }

  /**
   * Get PR template from the repository if available
   * Checks standard GitHub template locations
   */
  async getPRTemplate(): Promise<string | null> {
    const templatePaths = [
      '.github/PULL_REQUEST_TEMPLATE.md',
      '.github/pull_request_template.md',
      'docs/PULL_REQUEST_TEMPLATE.md',
      'docs/pull_request_template.md',
      'PULL_REQUEST_TEMPLATE.md',
      'pull_request_template.md',
    ];

    // Try local files first (faster)
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    for (const templatePath of templatePaths) {
      try {
        const fullPath = path.resolve(process.cwd(), templatePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        if (content.trim()) {
          return content;
        }
      } catch {
        // File doesn't exist locally, continue
      }
    }

    // Fall back to GitHub API
    for (const templatePath of templatePaths) {
      const content = await this.getFileContent(templatePath);
      if (content) {
        return content;
      }
    }

    return null;
  }

  async getFileContent(path: string): Promise<string | null> {
    try {
      const response = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ref: this.baseBranch,
      });

      if ('content' in response.data) {
        return Buffer.from(response.data.content, 'base64').toString('utf-8');
      }

      return null;
    } catch {
      return null;
    }
  }

  async getRepositoryStructure(maxDepth: number = 3): Promise<string[]> {
    const files: string[] = [];

    const fetchTree = async (path: string = '', depth: number = 0): Promise<void> => {
      if (depth > maxDepth) return;

      try {
        const response = await this.octokit.repos.getContent({
          owner: this.owner,
          repo: this.repo,
          path,
          ref: this.baseBranch,
        });

        if (Array.isArray(response.data)) {
          for (const item of response.data) {
            if (item.type === 'file') {
              files.push(item.path);
            } else if (item.type === 'dir') {
              files.push(item.path + '/');
              await fetchTree(item.path, depth + 1);
            }
          }
        }
      } catch {
        // Ignore errors for inaccessible paths
      }
    };

    await fetchTree();
    return files;
  }

  async getLocalFiles(): Promise<string[]> {
    const { globby } = await import('globby');

    return globby(['**/*'], {
      gitignore: true,
      ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
      cwd: process.cwd(),
    });
  }

  async readLocalFile(filePath: string): Promise<string | null> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    try {
      const fullPath = path.resolve(process.cwd(), filePath);
      return await fs.readFile(fullPath, 'utf-8');
    } catch {
      return null;
    }
  }

  // ==================== REMOTE MODE METHODS ====================
  // These methods work entirely via GitHub API, no local git needed

  /**
   * Get the full file tree from GitHub API (better than getRepositoryStructure)
   * Uses the Git Trees API for efficient recursive listing
   */
  async getRemoteFiles(): Promise<string[]> {
    try {
      // Get the SHA of the base branch
      const refResponse = await this.octokit.git.getRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${this.baseBranch}`,
      });
      const commitSha = refResponse.data.object.sha;

      // Get the commit to find tree SHA
      const commitResponse = await this.octokit.git.getCommit({
        owner: this.owner,
        repo: this.repo,
        commit_sha: commitSha,
      });
      const treeSha = commitResponse.data.tree.sha;

      // Get the full tree recursively
      const treeResponse = await this.octokit.git.getTree({
        owner: this.owner,
        repo: this.repo,
        tree_sha: treeSha,
        recursive: 'true',
      });

      // Filter to only files (not directories) and exclude common ignored paths
      const ignoredPaths = ['node_modules/', '.git/', 'dist/', 'build/', '.next/', 'coverage/'];

      return treeResponse.data.tree
        .filter(item => item.type === 'blob' && item.path)
        .map(item => item.path as string)
        .filter(path => !ignoredPaths.some(ignored => path.startsWith(ignored)));
    } catch (error) {
      console.error('Failed to get remote files:', error);
      return [];
    }
  }

  /**
   * Create a branch remotely via GitHub API
   */
  async createBranchRemote(branchName: string): Promise<void> {
    // Get the SHA of the base branch
    const refResponse = await this.octokit.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${this.baseBranch}`,
    });
    const baseSha = refResponse.data.object.sha;

    // Create the new branch
    await this.octokit.git.createRef({
      owner: this.owner,
      repo: this.repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    });
  }

  /**
   * Apply changes and create a commit remotely via GitHub API
   * Creates a single commit with all file changes
   */
  async applyChangesRemote(
    branchName: string,
    changes: FileChange[],
    commitMessage: string
  ): Promise<void> {
    // Get the current commit SHA of the branch
    const refResponse = await this.octokit.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${branchName}`,
    });
    const parentSha = refResponse.data.object.sha;

    // Get the tree SHA from the parent commit
    const parentCommit = await this.octokit.git.getCommit({
      owner: this.owner,
      repo: this.repo,
      commit_sha: parentSha,
    });
    const baseTreeSha = parentCommit.data.tree.sha;

    // Create blobs for each file and build the tree
    const treeItems: { path: string; mode: '100644' | '100755' | '040000' | '160000' | '120000'; type: 'blob' | 'tree' | 'commit'; sha?: string | null }[] = [];

    for (const change of changes) {
      if (change.operation === 'delete') {
        // For deletions, we set sha to null
        treeItems.push({
          path: change.path,
          mode: '100644',
          type: 'blob',
          sha: null,
        });
      } else {
        // Create a blob for the file content
        const blobResponse = await this.octokit.git.createBlob({
          owner: this.owner,
          repo: this.repo,
          content: Buffer.from(change.content).toString('base64'),
          encoding: 'base64',
        });

        treeItems.push({
          path: change.path,
          mode: '100644',
          type: 'blob',
          sha: blobResponse.data.sha,
        });
      }
    }

    // Create a new tree with the changes
    const newTree = await this.octokit.git.createTree({
      owner: this.owner,
      repo: this.repo,
      base_tree: baseTreeSha,
      tree: treeItems,
    });

    // Create a new commit
    const newCommit = await this.octokit.git.createCommit({
      owner: this.owner,
      repo: this.repo,
      message: commitMessage,
      tree: newTree.data.sha,
      parents: [parentSha],
    });

    // Update the branch reference to point to the new commit
    await this.octokit.git.updateRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${branchName}`,
      sha: newCommit.data.sha,
    });
  }

  /**
   * Get PR template remotely (API only, no local files)
   */
  async getPRTemplateRemote(): Promise<string | null> {
    const templatePaths = [
      '.github/PULL_REQUEST_TEMPLATE.md',
      '.github/pull_request_template.md',
      'docs/PULL_REQUEST_TEMPLATE.md',
      'docs/pull_request_template.md',
      'PULL_REQUEST_TEMPLATE.md',
      'pull_request_template.md',
    ];

    for (const templatePath of templatePaths) {
      const content = await this.getFileContent(templatePath);
      if (content) {
        return content;
      }
    }

    return null;
  }
}
