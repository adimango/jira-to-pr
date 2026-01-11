import chalk from 'chalk';
import type { FileChange } from './types.js';

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header';
  content: string;
}

/**
 * Generate a unified diff between two strings
 */
function generateUnifiedDiff(oldContent: string, newContent: string): DiffLine[] {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const diff: DiffLine[] = [];

  // Simple LCS-based diff algorithm
  const lcs = computeLCS(oldLines, newLines);

  let oldIdx = 0;
  let newIdx = 0;
  let lcsIdx = 0;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    if (lcsIdx < lcs.length && oldIdx < oldLines.length && oldLines[oldIdx] === lcs[lcsIdx]) {
      if (newIdx < newLines.length && newLines[newIdx] === lcs[lcsIdx]) {
        // Context line (unchanged)
        diff.push({ type: 'context', content: oldLines[oldIdx] });
        oldIdx++;
        newIdx++;
        lcsIdx++;
      } else {
        // Added line
        diff.push({ type: 'add', content: newLines[newIdx] });
        newIdx++;
      }
    } else if (lcsIdx < lcs.length && newIdx < newLines.length && newLines[newIdx] === lcs[lcsIdx]) {
      // Removed line
      diff.push({ type: 'remove', content: oldLines[oldIdx] });
      oldIdx++;
    } else if (oldIdx < oldLines.length && (lcsIdx >= lcs.length || oldLines[oldIdx] !== lcs[lcsIdx])) {
      // Removed line
      diff.push({ type: 'remove', content: oldLines[oldIdx] });
      oldIdx++;
    } else if (newIdx < newLines.length) {
      // Added line
      diff.push({ type: 'add', content: newLines[newIdx] });
      newIdx++;
    }
  }

  return diff;
}

/**
 * Compute Longest Common Subsequence
 */
function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find LCS
  const lcs: string[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lcs.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return lcs;
}

/**
 * Collapse context lines, showing only a few around changes
 */
function collapseContext(diff: DiffLine[], contextLines: number = 3): DiffLine[] {
  const result: DiffLine[] = [];
  const changeIndices: number[] = [];

  // Find all change indices
  diff.forEach((line, idx) => {
    if (line.type === 'add' || line.type === 'remove') {
      changeIndices.push(idx);
    }
  });

  if (changeIndices.length === 0) {
    return [{ type: 'context', content: '(no changes)' }];
  }

  // Build set of lines to show
  const showLines = new Set<number>();
  for (const idx of changeIndices) {
    for (let i = Math.max(0, idx - contextLines); i <= Math.min(diff.length - 1, idx + contextLines); i++) {
      showLines.add(i);
    }
  }

  let lastShown = -1;
  for (let i = 0; i < diff.length; i++) {
    if (showLines.has(i)) {
      if (lastShown !== -1 && i - lastShown > 1) {
        // Add separator for skipped lines
        const skipped = i - lastShown - 1;
        result.push({ type: 'header', content: `... ${skipped} unchanged lines ...` });
      }
      result.push(diff[i]);
      lastShown = i;
    }
  }

  return result;
}

/**
 * Format a diff line with colors
 */
function formatDiffLine(line: DiffLine, lineNum?: { old?: number; new?: number }): string {
  const prefix = lineNum
    ? chalk.dim(`${(lineNum.old ?? '').toString().padStart(4)} ${(lineNum.new ?? '').toString().padStart(4)} │ `)
    : '';

  switch (line.type) {
    case 'add':
      return prefix + chalk.green(`+ ${line.content}`);
    case 'remove':
      return prefix + chalk.red(`- ${line.content}`);
    case 'context':
      return prefix + chalk.dim(`  ${line.content}`);
    case 'header':
      return chalk.cyan(`  ${line.content}`);
  }
}

/**
 * Display a colored diff for a file change
 */
export function displayFileDiff(
  change: FileChange,
  originalContent: string | null
): void {
  const header = getFileHeader(change);
  console.log(header);
  console.log(chalk.dim('─'.repeat(60)));

  if (change.operation === 'create') {
    // Show all lines as added
    const lines = change.content.split('\n');
    const preview = lines.slice(0, 20);
    preview.forEach((line, idx) => {
      console.log(chalk.green(`+ ${(idx + 1).toString().padStart(3)} │ ${line}`));
    });
    if (lines.length > 20) {
      console.log(chalk.cyan(`  ... and ${lines.length - 20} more lines`));
    }
  } else if (change.operation === 'delete') {
    // Show all lines as removed
    const lines = (originalContent || '').split('\n');
    const preview = lines.slice(0, 20);
    preview.forEach((line, idx) => {
      console.log(chalk.red(`- ${(idx + 1).toString().padStart(3)} │ ${line}`));
    });
    if (lines.length > 20) {
      console.log(chalk.cyan(`  ... and ${lines.length - 20} more lines`));
    }
  } else {
    // Show diff
    const diff = generateUnifiedDiff(originalContent || '', change.content);
    const collapsed = collapseContext(diff, 3);

    let oldLineNum = 1;
    let newLineNum = 1;

    for (const line of collapsed) {
      if (line.type === 'header') {
        console.log(formatDiffLine(line));
      } else if (line.type === 'remove') {
        console.log(formatDiffLine(line, { old: oldLineNum }));
        oldLineNum++;
      } else if (line.type === 'add') {
        console.log(formatDiffLine(line, { new: newLineNum }));
        newLineNum++;
      } else {
        console.log(formatDiffLine(line, { old: oldLineNum, new: newLineNum }));
        oldLineNum++;
        newLineNum++;
      }
    }
  }

  console.log();
}

function getFileHeader(change: FileChange): string {
  const icon = change.operation === 'create'
    ? chalk.green('+++')
    : change.operation === 'delete'
      ? chalk.red('---')
      : chalk.yellow('~~~');

  const label = change.operation === 'create'
    ? chalk.green('new file')
    : change.operation === 'delete'
      ? chalk.red('deleted')
      : chalk.yellow('modified');

  return `\n${icon} ${chalk.bold(change.path)} ${chalk.dim(`(${label})`)}`;
}

/**
 * Display a summary of all changes
 */
export function displayDiffSummary(changes: FileChange[]): void {
  const created = changes.filter(c => c.operation === 'create').length;
  const modified = changes.filter(c => c.operation === 'modify').length;
  const deleted = changes.filter(c => c.operation === 'delete').length;

  const parts: string[] = [];
  if (created > 0) parts.push(chalk.green(`${created} created`));
  if (modified > 0) parts.push(chalk.yellow(`${modified} modified`));
  if (deleted > 0) parts.push(chalk.red(`${deleted} deleted`));

  console.log(chalk.bold('\n📊 Change Summary: ') + parts.join(', '));
}

/**
 * Display all file diffs
 */
export async function displayAllDiffs(
  changes: FileChange[],
  getOriginalContent: (path: string) => Promise<string | null>
): Promise<void> {
  console.log(chalk.bold('\n📝 Diff Preview:\n'));

  for (const change of changes) {
    const originalContent = change.operation === 'modify'
      ? await getOriginalContent(change.path)
      : null;
    displayFileDiff(change, originalContent);
  }

  displayDiffSummary(changes);
}
