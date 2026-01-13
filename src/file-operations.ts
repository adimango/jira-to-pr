import type { FileChange } from './types.js';
import type { GitHubClient } from './github.js';

/**
 * Abstract interface for file operations
 * Allows switching between local and remote modes
 */
export interface FileOperations {
  /** Get list of all files in the repository */
  getFiles(): Promise<string[]>;

  /** Read content of a specific file */
  readFile(path: string): Promise<string | null>;

  /** Get PR template if available */
  getPRTemplate(): Promise<string | null>;

  /** Create a new branch */
  createBranch(branchName: string): Promise<void>;

  /** Apply file changes locally without committing (for local review) */
  applyChangesLocally(changes: FileChange[]): Promise<void>;

  /** Discard local changes (restore original files) */
  discardChanges(changes: FileChange[]): Promise<void>;

  /** Commit and push changes (after local review) */
  commitAndPush(branchName: string, commitMessage: string): Promise<void>;

  /** Apply file changes and commit */
  applyChangesAndCommit(
    branchName: string,
    changes: FileChange[],
    commitMessage: string
  ): Promise<void>;

  /** Check if ready to make changes (e.g., clean working tree) */
  checkReady(): Promise<{ ready: boolean; message?: string }>;

  /** Check if local mode is supported */
  supportsLocalReview(): boolean;
}

/**
 * Local file operations using local git and filesystem
 */
export class LocalFileOperations implements FileOperations {
  private originalContents: Map<string, string | null> = new Map();

  constructor(private github: GitHubClient) {}

  async getFiles(): Promise<string[]> {
    return this.github.getLocalFiles();
  }

  async readFile(path: string): Promise<string | null> {
    return this.github.readLocalFile(path);
  }

  async getPRTemplate(): Promise<string | null> {
    return this.github.getPRTemplate();
  }

  async createBranch(branchName: string): Promise<void> {
    return this.github.createBranch(branchName);
  }

  async applyChangesLocally(changes: FileChange[]): Promise<void> {
    // Store original contents for potential discard
    for (const change of changes) {
      if (change.operation === 'create') {
        this.originalContents.set(change.path, null); // File didn't exist
      } else {
        const content = await this.github.readLocalFile(change.path);
        this.originalContents.set(change.path, content);
      }
    }
    // Apply the changes without committing
    await this.github.applyChanges(changes);
  }

  async discardChanges(changes: FileChange[]): Promise<void> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    for (const change of changes) {
      const filePath = path.resolve(process.cwd(), change.path);
      const originalContent = this.originalContents.get(change.path);

      if (originalContent === null) {
        // File was created, delete it
        await fs.unlink(filePath).catch(() => {});
      } else if (originalContent !== undefined) {
        // Restore original content
        await fs.writeFile(filePath, originalContent, 'utf-8');
      }
    }
    this.originalContents.clear();
  }

  async commitAndPush(branchName: string, commitMessage: string): Promise<void> {
    await this.github.commitChanges(commitMessage);
    await this.github.pushBranch(branchName);
    this.originalContents.clear();
  }

  async applyChangesAndCommit(
    branchName: string,
    changes: FileChange[],
    commitMessage: string
  ): Promise<void> {
    await this.github.applyChanges(changes);
    await this.github.commitChanges(commitMessage);
    await this.github.pushBranch(branchName);
  }

  async checkReady(): Promise<{ ready: boolean; message?: string }> {
    const isClean = await this.github.isWorkingTreeClean();
    if (!isClean) {
      return {
        ready: false,
        message: 'Please commit or stash your changes before running jira-to-pr',
      };
    }
    return { ready: true };
  }

  supportsLocalReview(): boolean {
    return true;
  }
}

/**
 * Remote file operations using GitHub API only
 */
export class RemoteFileOperations implements FileOperations {
  constructor(private github: GitHubClient) {}

  async getFiles(): Promise<string[]> {
    return this.github.getRemoteFiles();
  }

  async readFile(path: string): Promise<string | null> {
    return this.github.getFileContent(path);
  }

  async getPRTemplate(): Promise<string | null> {
    return this.github.getPRTemplateRemote();
  }

  async createBranch(branchName: string): Promise<void> {
    return this.github.createBranchRemote(branchName);
  }

  async applyChangesLocally(_changes: FileChange[]): Promise<void> {
    throw new Error('Local review not supported in remote mode');
  }

  async discardChanges(_changes: FileChange[]): Promise<void> {
    throw new Error('Discard not supported in remote mode');
  }

  async commitAndPush(_branchName: string, _commitMessage: string): Promise<void> {
    throw new Error('commitAndPush not supported in remote mode - use applyChangesAndCommit');
  }

  async applyChangesAndCommit(
    branchName: string,
    changes: FileChange[],
    commitMessage: string
  ): Promise<void> {
    await this.github.applyChangesRemote(branchName, changes, commitMessage);
  }

  async checkReady(): Promise<{ ready: boolean; message?: string }> {
    // Remote mode is always ready - no local state to check
    return { ready: true };
  }

  supportsLocalReview(): boolean {
    return false;
  }
}

/**
 * Factory function to create the appropriate file operations
 */
export function createFileOperations(
  github: GitHubClient,
  remote: boolean
): FileOperations {
  return remote
    ? new RemoteFileOperations(github)
    : new LocalFileOperations(github);
}
