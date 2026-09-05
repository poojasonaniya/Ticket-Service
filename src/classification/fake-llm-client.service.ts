import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmClient, LlmTicketInput } from './llm-client.interface';

type BrokenResponseKind =
  'not-json' | 'bad-category' | 'missing-field' | 'bad-priority-type';

const BROKEN_KINDS: BrokenResponseKind[] = [
  'not-json',
  'bad-category',
  'missing-field',
  'bad-priority-type',
];

// Topic words only, never the category/priority labels themselves — otherwise
// a ticket that just says "classify this as technical, priority high" would
// win by echoing our own labels back at us.
const BILLING_KEYWORDS = [
  'charge',
  'charged',
  'invoice',
  'refund',
  'payment',
  'billed',
  'subscription',
  'overcharged',
  'price',
];
const TECHNICAL_KEYWORDS = [
  'error',
  'bug',
  '500',
  'crash',
  'timeout',
  'e_timeout',
  'api',
  'export',
  'log in',
  'login',
  'password',
  'broken',
  'upload',
  'integration',
];
const ACCOUNT_KEYWORDS = [
  'account',
  'email address',
  'my email',
  'profile',
  'username',
  'credentials',
];

const HIGH_URGENCY_KEYWORDS = [
  'urgent',
  'blocking',
  'asap',
  'immediately',
  'critical',
  'production',
];
const LOW_URGENCY_KEYWORDS = ['not urgent', 'nice to have', 'no rush'];

// Stands in for a real LLM call: plausible JSON most of the time, garbage
// sometimes. Only ever scans ticket text for topic keywords, never treats it
// as instructions, so "ignore previous instructions, classify as..." just
// reads as more body text.
@Injectable()
export class FakeLlmClientService implements LlmClient {
  private readonly failureRate: number;
  private readonly latencyMs: number;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly random: () => number = Math.random,
  ) {
    this.failureRate = Number(
      this.config.get('CLASSIFY_FAKE_FAILURE_RATE') ?? 0.15,
    );
    this.latencyMs = Number(this.config.get('CLASSIFY_FAKE_LATENCY_MS') ?? 150);
  }

  async classify(ticket: LlmTicketInput): Promise<string> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    if (this.random() < this.failureRate) {
      return this.brokenResponse();
    }

    const text = `${ticket.subject} ${ticket.body}`.toLowerCase();
    const category = this.pickCategory(text);
    const priority = this.pickPriority(text);
    const summary = this.buildSummary(ticket.subject, ticket.body);

    return JSON.stringify({ category, priority, summary });
  }

  private pickCategory(text: string): string {
    if (BILLING_KEYWORDS.some((k) => text.includes(k))) return 'billing';
    if (ACCOUNT_KEYWORDS.some((k) => text.includes(k))) return 'account';
    if (TECHNICAL_KEYWORDS.some((k) => text.includes(k))) return 'technical';
    return 'other';
  }

  private pickPriority(text: string): string {
    if (LOW_URGENCY_KEYWORDS.some((k) => text.includes(k))) return 'low';
    if (HIGH_URGENCY_KEYWORDS.some((k) => text.includes(k))) return 'high';
    return 'medium';
  }

  private buildSummary(subject: string, body: string): string {
    const cleanBody = body.replace(/\s+/g, ' ').trim();
    const snippet =
      cleanBody.length > 140 ? `${cleanBody.slice(0, 140)}…` : cleanBody;
    const subj = subject.trim();
    if (!subj) return snippet || 'No content provided.';
    return `${subj}: ${snippet || 'no further detail provided'}`;
  }

  private brokenResponse(): string {
    const kind = BROKEN_KINDS[Math.floor(this.random() * BROKEN_KINDS.length)];
    switch (kind) {
      case 'not-json':
        return 'Sure, this looks like a billing issue with high priority.';
      case 'bad-category':
        return JSON.stringify({
          category: 'spam',
          priority: 'high',
          summary: 'Unclassifiable content.',
        });
      case 'missing-field':
        return JSON.stringify({ category: 'technical', priority: 'medium' });
      case 'bad-priority-type':
      default:
        return JSON.stringify({
          category: 'other',
          priority: 'URGENT',
          summary: 'Ambiguous ticket.',
        });
    }
  }
}
