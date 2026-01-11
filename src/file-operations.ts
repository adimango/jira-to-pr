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

  /** Apply file changes and commit */
  applyChangesAndCommit(
    branchName: string,
    changes: FileChange[],
    commitMessage: string
  ): Promise<void>;

  /** Check if ready to make changes (e.g., clean working tree) */
  checkReady(): Promise<{ ready: boolean; message?: string }>;
}

/**
 * Local file operations using local git and filesystem
 */
export class LocalFileOperations implements FileOperations {
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
