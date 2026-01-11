import type { Config, JiraTicket } from './types.js';

export class JiraClient {
  private baseUrl: string;
  private authHeader: string;
  private projectKey: string;
  private labelFilter?: string;

  constructor(config: Config['jira']) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.authHeader = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`;
    this.projectKey = config.projectKey;
    this.labelFilter = config.labelFilter;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/rest/api/3${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Jira API error (${response.status}): ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  async getTicket(ticketKey: string): Promise<JiraTicket> {
    const data = await this.request<JiraIssueResponse>(`/issue/${ticketKey}`);
    return this.parseTicket(data);
  }

  async searchTickets(jql?: string): Promise<JiraTicket[]> {
    let query = jql;

    if (!query) {
      query = `project = ${this.projectKey}`;
      if (this.labelFilter) {
        query += ` AND labels = "${this.labelFilter}"`;
      }
      query += ' AND status != Done ORDER BY created DESC';
    }

    const data = await this.request<JiraSearchResponse>('/search', {
      method: 'POST',
      body: JSON.stringify({
        jql: query,
        maxResults: 50,
        fields: [
          'summary',
          'description',
          'status',
          'assignee',
          'labels',
          'issuetype',
          'priority',
          'components',
          'customfield_10016', // Acceptance criteria (common field)
        ],
      }),
    });

    return data.issues.map((issue) => this.parseTicket(issue));
  }

  private parseTicket(issue: JiraIssue): JiraTicket {
    const fields = issue.fields;

    // Try to extract acceptance criteria from description or custom field
    let acceptanceCriteria: string | null = null;

    // Check for custom field (common Jira field for AC)
    if (fields.customfield_10016) {
      acceptanceCriteria = this.extractTextFromDocument(fields.customfield_10016);
    }

    // Try to extract from description if not found
    if (!acceptanceCriteria && fields.description) {
      const descText = this.extractTextFromDocument(fields.description);
      const acMatch = descText.match(/acceptance\s*criteria[:\s]*(.+?)(?=\n\n|\n[A-Z]|$)/is);
      if (acMatch) {
        acceptanceCriteria = acMatch[1].trim();
      }
    }

    return {
      key: issue.key,
      summary: fields.summary,
      description: fields.description ? this.extractTextFromDocument(fields.description) : null,
      acceptanceCriteria,
      status: fields.status?.name || 'Unknown',
      assignee: fields.assignee?.displayName || null,
      labels: fields.labels || [],
      issueType: fields.issuetype?.name || 'Unknown',
      priority: fields.priority?.name || 'Medium',
      components: fields.components?.map((c) => c.name) || [],
    };
  }

  private extractTextFromDocument(doc: JiraDocument | string): string {
    if (typeof doc === 'string') {
      return doc;
    }

    if (!doc || !doc.content) {
      return '';
    }

    const extractFromNode = (node: JiraDocumentNode): string => {
      if (node.type === 'text' && node.text) {
        return node.text;
      }

      if (node.content) {
        return node.content.map(extractFromNode).join('');
      }

      return '';
    };

    return doc.content
      .map((node) => {
        const text = extractFromNode(node);
        if (node.type === 'paragraph' || node.type === 'heading') {
          return text + '\n';
        }
        if (node.type === 'bulletList' || node.type === 'orderedList') {
          return (
            node.content
              ?.map((item, index) => {
                const prefix = node.type === 'orderedList' ? `${index + 1}. ` : '- ';
                return prefix + extractFromNode(item);
              })
              .join('\n') + '\n'
          );
        }
        return text;
      })
      .join('')
      .trim();
  }
}

// Jira API types
interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description: JiraDocument | null;
    status: { name: string } | null;
    assignee: { displayName: string } | null;
    labels: string[];
    issuetype: { name: string } | null;
    priority: { name: string } | null;
    components: { name: string }[];
    customfield_10016?: JiraDocument | string;
  };
}

interface JiraIssueResponse extends JiraIssue {}

interface JiraSearchResponse {
  issues: JiraIssue[];
  total: number;
}

interface JiraDocument {
  type: string;
  content?: JiraDocumentNode[];
}

interface JiraDocumentNode {
  type: string;
  text?: string;
  content?: JiraDocumentNode[];
}
