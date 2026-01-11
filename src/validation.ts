import type { FileChange } from './types.js';

// Test file patterns
const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\/__tests__\//,
  /\/test\//,
  /\/tests\//,
  /_test\.[jt]sx?$/,
  /\.test\.py$/,
  /_test\.py$/,
  /test_.*\.py$/,
  /\.spec\.rb$/,
  /_spec\.rb$/,
  /\.test\.go$/,
  /_test\.go$/,
];

// Files that don't need tests (config, docs, etc.)
const NON_BEHAVIORAL_PATTERNS = [
  /\.md$/i,
  /\.txt$/i,
  /\.json$/i,
  /\.ya?ml$/i,
  /\.toml$/i,
  /\.env/i,
  /\.gitignore$/i,
  /\.prettierrc/i,
  /\.eslint/i,
  /tsconfig/i,
  /package\.json$/i,
  /package-lock\.json$/i,
  /pnpm-lock\.yaml$/i,
  /yarn\.lock$/i,
  /LICENSE/i,
  /CHANGELOG/i,
  /README/i,
];

/**
 * Check if a file path is a test file.
 */
export function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * Check if a file is behavioral code (vs config/docs).
 */
function isBehavioralFile(filePath: string): boolean {
  return !NON_BEHAVIORAL_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * Check if the repository has existing tests.
 */
export function repoHasTests(allFiles: string[]): boolean {
  return allFiles.some(isTestFile);
}

/**
 * Validate that changes include test updates when appropriate.
 * Returns warnings, not errors - this is advisory.
 */
export function validateTestCoverage(
  changes: FileChange[],
  allFiles: string[]
): string[] {
  const warnings: string[] = [];

  const hasTests = repoHasTests(allFiles);
  const changedBehavioralFiles = changes.filter(
    (c) => c.operation !== 'delete' && isBehavioralFile(c.path) && !isTestFile(c.path)
  );
  const changedTestFiles = changes.filter((c) => isTestFile(c.path));

  // If repo has tests but changes don't include any test updates
  if (hasTests && changedBehavioralFiles.length > 0 && changedTestFiles.length === 0) {
    warnings.push(
      'No test updates included. This repo has tests - consider adding coverage.'
    );
  }

  return warnings;
}
