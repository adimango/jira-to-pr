import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { Config, JiraTicket, FileChange, CodeGenerationResult, AIProvider } from './types.js';

// Instruction file locations to check (in priority order)
export const INSTRUCTION_FILES = [
  'CLAUDE.md',
  '.claude/instructions.md',
  '.claude/CLAUDE.md',
  '.github/CLAUDE.md',
  'AGENTS.md',
  '.cursor/rules',
  '.cursorrules',
];

// Default models for each provider
const DEFAULT_MODELS: Record<AIProvider, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  ollama: 'llama3.1',
};

interface AIProviderClient {
  generateText(
    systemPrompt: string,
    userPrompt: string,
    onToken?: (token: string) => void
  ): Promise<string>;
}

class AnthropicProvider implements AIProviderClient {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async generateText(
    systemPrompt: string,
    userPrompt: string,
    onToken?: (token: string) => void
  ): Promise<string> {
    if (onToken) {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      let fullText = '';
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          fullText += event.delta.text;
          onToken(event.delta.text);
        }
      }
      return fullText;
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from Anthropic');
    }
    return content.text;
  }
}

class OpenAIProvider implements AIProviderClient {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string, baseUrl?: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
    });
    this.model = model;
  }

  async generateText(
    systemPrompt: string,
    userPrompt: string,
    onToken?: (token: string) => void
  ): Promise<string> {
    if (onToken) {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: 8192,
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });

      let fullText = '';
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || '';
        fullText += text;
        if (text) onToken(text);
      }
      return fullText;
    }

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 8192,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    return response.choices[0]?.message?.content || '';
  }
}

class OllamaProvider implements AIProviderClient {
  private baseUrl: string;
  private model: string;

  constructor(model: string, baseUrl: string = 'http://localhost:11434') {
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async generateText(
    systemPrompt: string,
    userPrompt: string,
    onToken?: (token: string) => void
  ): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: !!onToken,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.statusText}`);
    }

    if (onToken && response.body) {
      let fullText = '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(Boolean);

        for (const line of lines) {
          try {
            const json = JSON.parse(line);
            if (json.message?.content) {
              fullText += json.message.content;
              onToken(json.message.content);
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }
      return fullText;
    }

    const data = await response.json() as { message?: { content?: string } };
    return data.message?.content || '';
  }
}

function createProvider(config: Config['ai']): AIProviderClient {
  const model = config.model || DEFAULT_MODELS[config.provider];

  switch (config.provider) {
    case 'anthropic':
      if (!config.apiKey) throw new Error('ANTHROPIC_API_KEY is required');
      return new AnthropicProvider(config.apiKey, model);

    case 'openai':
      if (!config.apiKey) throw new Error('OPENAI_API_KEY is required');
      return new OpenAIProvider(config.apiKey, model, config.baseUrl);

    case 'ollama':
      return new OllamaProvider(model, config.baseUrl || 'http://localhost:11434');

    default:
      throw new Error(`Unknown AI provider: ${config.provider}`);
  }
}

export class AIClient {
  private provider: AIProviderClient;
  private providerName: AIProvider;

  constructor(config: Config['ai']) {
    this.provider = createProvider(config);
    this.providerName = config.provider;
  }

  getProviderName(): AIProvider {
    return this.providerName;
  }

  /**
   * Load project-specific instructions from common instruction files
   */
  loadProjectInstructions(cwd: string = process.cwd()): { content: string; file: string } | null {
    for (const file of INSTRUCTION_FILES) {
      const filePath = join(cwd, file);
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, 'utf-8').trim();
          if (content) {
            return { content, file };
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
    return null;
  }

  async generateCode(
    ticket: JiraTicket,
    repoContext: {
      files: string[];
      relevantFileContents: Map<string, string>;
      language: string | null;
      projectInstructions?: { content: string; file: string } | null;
      prTemplate?: string | null;
    },
    onToken?: (token: string) => void
  ): Promise<CodeGenerationResult> {
    const instructions = repoContext.projectInstructions ?? this.loadProjectInstructions();
    const systemPrompt = this.buildSystemPrompt(repoContext, instructions?.content ?? null, repoContext.prTemplate ?? null);
    const userPrompt = this.buildUserPrompt(ticket, repoContext);

    const text = await this.provider.generateText(systemPrompt, userPrompt, onToken);
    return this.parseResponse(text, ticket);
  }

  async identifyRelevantFiles(ticket: JiraTicket, allFiles: string[]): Promise<string[]> {
    const systemPrompt = `You are a code analysis assistant. Given a Jira ticket and a list of files in a repository, identify which files are most likely to be relevant for implementing the ticket. Return a JSON array of file paths, maximum 10 files. Order by relevance (most relevant first). Only return the JSON array, no other text.`;

    const userPrompt = `Ticket: ${ticket.key}
Summary: ${ticket.summary}
Description: ${ticket.description || 'None'}
Acceptance Criteria: ${ticket.acceptanceCriteria || 'None'}

Files in repository:
${allFiles.join('\n')}

Return a JSON array of the most relevant file paths for implementing this ticket.`;

    try {
      const text = await this.provider.generateText(systemPrompt, userPrompt);
      let cleaned = text.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      const files = JSON.parse(cleaned);
      if (Array.isArray(files)) {
        return files.filter((f) => typeof f === 'string' && allFiles.includes(f));
      }
    } catch {
      // Fall back to keyword matching
      const keywords = (ticket.summary + ' ' + (ticket.description || ''))
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3);

      return allFiles
        .filter((f) => keywords.some((k) => f.toLowerCase().includes(k)))
        .slice(0, 10);
    }

    return [];
  }

  private buildSystemPrompt(
    repoContext: { files: string[]; language: string | null },
    projectInstructions: string | null,
    prTemplate: string | null
  ): string {
    let prompt = `You are a senior software engineer tasked with implementing features and fixes based on Jira tickets.
Your goal is to produce minimal, clean, production-ready code changes that satisfy the acceptance criteria.

Guidelines:
- Write minimal code that satisfies the requirements - no over-engineering
- Follow the existing code style and patterns in the repository
- Only modify files that are absolutely necessary
- Include proper error handling where appropriate
- Write code that a careful senior engineer would trust
- Do not add unnecessary comments or documentation unless the code is complex
`;

    if (projectInstructions) {
      prompt += `
## Project-Specific Instructions

The following instructions were found in the project's instruction file (CLAUDE.md or similar).
You MUST follow these instructions when generating code:

${projectInstructions}

---
`;
    }

    if (prTemplate) {
      prompt += `
## Pull Request Template

The repository has a PR template. You MUST use this template structure for the prBody field.
Fill in the sections appropriately based on the changes you make.

Template:
${prTemplate}

---
`;
    }

    prompt += `
Repository context:
- Primary language: ${repoContext.language || 'Unknown'}
- File structure: ${repoContext.files.slice(0, 50).join(', ')}${repoContext.files.length > 50 ? '...' : ''}

Response format:
You must respond with a valid JSON object containing the following fields:
{
  "changes": [
    {
      "path": "relative/path/to/file.ts",
      "content": "full file content here",
      "operation": "create" | "modify" | "delete"
    }
  ],
  "explanation": "Brief explanation of changes",
  "branchName": "feature/ticket-key-short-description",
  "commitMessage": "feat: short description of change",
  "prTitle": "Short PR title",
  "prBody": "Detailed PR description following the template above (if provided)"
}

IMPORTANT: Your response must be ONLY the JSON object, no markdown code blocks or other text.`;

    return prompt;
  }

  private buildUserPrompt(
    ticket: JiraTicket,
    repoContext: { relevantFileContents: Map<string, string> }
  ): string {
    let prompt = `Please implement the following Jira ticket:

## Ticket: ${ticket.key}
**Summary:** ${ticket.summary}
**Type:** ${ticket.issueType}
**Priority:** ${ticket.priority}

### Description:
${ticket.description || 'No description provided'}

### Acceptance Criteria:
${ticket.acceptanceCriteria || 'No explicit acceptance criteria provided'}
`;

    if (repoContext.relevantFileContents.size > 0) {
      prompt += '\n### Relevant Existing Files:\n';
      for (const [path, content] of repoContext.relevantFileContents) {
        prompt += `\n#### ${path}\n\`\`\`\n${content}\n\`\`\`\n`;
      }
    }

    prompt += `
Please analyze the ticket and produce the minimal code changes needed to satisfy the acceptance criteria.
Respond with a JSON object as specified in the system prompt.`;

    return prompt;
  }

  private parseResponse(text: string, ticket: JiraTicket): CodeGenerationResult {
    let cleanedText = text.trim();
    if (cleanedText.startsWith('```json')) {
      cleanedText = cleanedText.slice(7);
    } else if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.slice(3);
    }
    if (cleanedText.endsWith('```')) {
      cleanedText = cleanedText.slice(0, -3);
    }
    cleanedText = cleanedText.trim();

    try {
      const parsed = JSON.parse(cleanedText);

      if (!Array.isArray(parsed.changes)) {
        throw new Error('Response must contain a changes array');
      }

      for (const change of parsed.changes) {
        if (!change.path || !change.operation) {
          throw new Error('Each change must have path and operation');
        }
        if (change.operation !== 'delete' && !change.content) {
          throw new Error('Non-delete changes must have content');
        }
      }

      return {
        changes: parsed.changes as FileChange[],
        explanation: parsed.explanation || 'No explanation provided',
        branchName: parsed.branchName || `feature/${ticket.key.toLowerCase()}-${this.slugify(ticket.summary)}`,
        commitMessage: parsed.commitMessage || `feat(${ticket.key}): ${ticket.summary}`,
        prTitle: parsed.prTitle || `[${ticket.key}] ${ticket.summary}`,
        prBody: parsed.prBody || this.generateDefaultPRBody(ticket, parsed.explanation),
      };
    } catch (error) {
      throw new Error(
        `Failed to parse AI response: ${error instanceof Error ? error.message : 'Unknown error'}\n\nRaw response:\n${text}`
      );
    }
  }

  async regenerateWithFeedback(
    ticket: JiraTicket,
    repoContext: {
      files: string[];
      relevantFileContents: Map<string, string>;
      language: string | null;
      projectInstructions?: { content: string; file: string } | null;
      prTemplate?: string | null;
    },
    previousResult: CodeGenerationResult,
    feedback: string,
    onToken?: (token: string) => void
  ): Promise<CodeGenerationResult> {
    const instructions = repoContext.projectInstructions ?? this.loadProjectInstructions();
    const systemPrompt = this.buildSystemPrompt(repoContext, instructions?.content ?? null, repoContext.prTemplate ?? null);

    const userPrompt = `${this.buildUserPrompt(ticket, repoContext)}

## Previous Attempt

The previous code generation produced these changes:
${previousResult.changes.map(c => `- ${c.operation} ${c.path}`).join('\n')}

Explanation: ${previousResult.explanation}

## User Feedback

The user wants the following changes:
${feedback}

Please regenerate the code taking this feedback into account.
Respond with a JSON object as specified in the system prompt.`;

    const text = await this.provider.generateText(systemPrompt, userPrompt, onToken);
    return this.parseResponse(text, ticket);
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30);
  }

  private generateDefaultPRBody(ticket: JiraTicket, explanation: string): string {
    return `## Summary
This PR implements [${ticket.key}](${ticket.key}).

${explanation}

## Changes
${ticket.summary}

## Acceptance Criteria
${ticket.acceptanceCriteria || 'See Jira ticket for details'}

## Testing
- [ ] Manual testing completed
- [ ] Unit tests added/updated (if applicable)

---
*Generated by jira-to-pr*`;
  }
}
