import chalk from 'chalk';
import ora, { Ora } from 'ora';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const THINKING_PHRASES = [
  'Analyzing ticket requirements',
  'Understanding codebase structure',
  'Identifying relevant patterns',
  'Planning implementation approach',
  'Generating code changes',
  'Reviewing for best practices',
  'Finalizing solution',
];

export class ThinkingIndicator {
  private spinner: Ora;
  private intervalId: NodeJS.Timeout | null = null;
  private frameIndex = 0;
  private phraseIndex = 0;
  private tokenCount = 0;
  private startTime: number = 0;
  private streamBuffer = '';
  private lastLineCount = 0;

  constructor() {
    this.spinner = ora({
      spinner: {
        frames: SPINNER_FRAMES,
        interval: 80,
      },
      color: 'cyan',
    });
  }

  start(message: string = 'Thinking'): void {
    this.startTime = Date.now();
    this.tokenCount = 0;
    this.streamBuffer = '';
    this.spinner.start(chalk.cyan(message));

    // Rotate through thinking phrases
    this.intervalId = setInterval(() => {
      this.phraseIndex = (this.phraseIndex + 1) % THINKING_PHRASES.length;
      this.updateDisplay();
    }, 3000);
  }

  private updateDisplay(): void {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const phrase = THINKING_PHRASES[this.phraseIndex];
    const tokenInfo = this.tokenCount > 0 ? ` (${this.tokenCount} tokens)` : '';
    this.spinner.text = chalk.cyan(`${phrase}...`) + chalk.dim(` ${elapsed}s${tokenInfo}`);
  }

  onToken(token: string): void {
    this.tokenCount++;
    this.streamBuffer += token;

    // Update display every 10 tokens
    if (this.tokenCount % 10 === 0) {
      this.updateDisplay();
    }
  }

  succeed(message: string): void {
    this.stop();
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    this.spinner.succeed(
      chalk.green(message) + chalk.dim(` (${elapsed}s, ${this.tokenCount} tokens)`)
    );
  }

  fail(message: string): void {
    this.stop();
    this.spinner.fail(chalk.red(message));
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.spinner.stop();
  }

  getBuffer(): string {
    return this.streamBuffer;
  }
}

export class StreamingDisplay {
  private lines: string[] = [];
  private maxLines = 6;
  private spinner: Ora;
  private isActive = false;
  private tokenCount = 0;
  private startTime = 0;

  constructor() {
    this.spinner = ora({ color: 'cyan' });
  }

  start(title: string): void {
    this.startTime = Date.now();
    this.tokenCount = 0;
    this.lines = [];
    this.isActive = true;
    console.log(chalk.cyan(`\n● ${title}`));
    console.log(chalk.dim('─'.repeat(50)));
  }

  onChunk(text: string): void {
    if (!this.isActive) return;

    this.tokenCount++;

    // Add text to buffer and process lines
    const allText = this.lines.join('') + text;
    this.lines = allText.split('\n').slice(-this.maxLines);

    // Clear previous lines and redraw
    this.redraw();
  }

  private redraw(): void {
    // Move cursor up and clear previous output
    if (this.lines.length > 0) {
      process.stdout.write(`\r${chalk.dim('...')} ${chalk.dim(this.getPreview())}`);
    }
  }

  private getPreview(): string {
    const lastLine = this.lines[this.lines.length - 1] || '';
    // Truncate to terminal width
    const maxWidth = process.stdout.columns ? process.stdout.columns - 10 : 70;
    if (lastLine.length > maxWidth) {
      return lastLine.slice(0, maxWidth - 3) + '...';
    }
    return lastLine;
  }

  succeed(message: string): void {
    this.isActive = false;
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    process.stdout.write('\r' + ' '.repeat(80) + '\r'); // Clear line
    console.log(chalk.dim('─'.repeat(50)));
    console.log(chalk.green(`✓ ${message}`) + chalk.dim(` (${elapsed}s)`));
  }

  fail(message: string): void {
    this.isActive = false;
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
    console.log(chalk.dim('─'.repeat(50)));
    console.log(chalk.red(`✗ ${message}`));
  }
}

export function createProgressBar(total: number, width: number = 30): (current: number) => string {
  return (current: number): string => {
    const percentage = Math.min(current / total, 1);
    const filled = Math.round(width * percentage);
    const empty = width - filled;
    const bar = chalk.cyan('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
    const pct = Math.round(percentage * 100);
    return `${bar} ${pct}%`;
  };
}
