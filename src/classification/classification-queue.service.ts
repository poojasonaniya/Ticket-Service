import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { LLM_CLIENT, LlmClient } from './llm-client.interface';
import { parseClassificationResponse } from './classification-result.schema';

// In-memory, concurrency-limited queue. No BullMQ/SQS — single process, and
// the ticket's `status` column already tells us what's been classified, so a
// second durable queue on top of that would just be another thing to keep in
// sync. Downside: the queue itself doesn't survive a restart, see
// onApplicationBootstrap for how that's handled.
@Injectable()
export class ClassificationQueueService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ClassificationQueueService.name);

  private readonly queue: string[] = [];
  private active = 0;

  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
    private readonly config: ConfigService,
  ) {
    this.concurrency = Number(this.config.get('CLASSIFY_CONCURRENCY') ?? 2);
    this.maxAttempts = Number(this.config.get('CLASSIFY_MAX_ATTEMPTS') ?? 3);
    this.retryBaseMs = Number(this.config.get('CLASSIFY_RETRY_BASE_MS') ?? 300);
  }

  // Anything still "processing" got interrupted by the last process dying —
  // we have no idea how far it got, so just reset to "pending" (leave
  // attempts alone, a crash shouldn't cost a retry) and requeue.
  async onApplicationBootstrap() {
    const recovered = await this.prisma.ticket.updateMany({
      where: { status: 'processing' },
      data: { status: 'pending' },
    });
    if (recovered.count > 0) {
      this.logger.warn(
        `recovered ${recovered.count} ticket(s) left "processing" by a previous run`,
      );
    }

    const pending = await this.prisma.ticket.findMany({
      where: { status: 'pending' },
      select: { id: true },
    });
    for (const ticket of pending) {
      this.enqueue(ticket.id);
    }
  }

  enqueue(ticketId: string): void {
    this.queue.push(ticketId);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const ticketId = this.queue.shift();
      if (!ticketId) break;
      this.active++;
      this.process(ticketId)
        .catch((err) => {
          // process() already handles validation errors and retries itself,
          // so anything landing here is a surprise (DB down, etc) — log it
          // and move on instead of taking the worker loop down with it.
          this.logger.error(`unexpected error classifying ${ticketId}`, err);
        })
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  private async process(ticketId: string): Promise<void> {
    // Claim it atomically — only proceed if it's still "pending". Without
    // this, two concurrent reclassify calls could both enqueue the same id
    // and we'd process it twice.
    const claim = await this.prisma.ticket.updateMany({
      where: { id: ticketId, status: 'pending' },
      data: { status: 'processing' },
    });
    if (claim.count === 0) return;

    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) return;

    try {
      const raw = await this.llm.classify({
        subject: ticket.subject,
        body: ticket.body,
      });
      const result = parseClassificationResponse(raw);

      await this.prisma.ticket.update({
        where: { id: ticketId },
        data: {
          status: 'classified',
          category: result.category,
          priority: result.priority,
          summary: result.summary,
          lastError: null,
        },
      });
    } catch (err) {
      const attempts = ticket.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);

      if (attempts < this.maxAttempts) {
        await this.prisma.ticket.update({
          where: { id: ticketId },
          data: { status: 'pending', attempts, lastError: message },
        });
        const delay = this.retryBaseMs * attempts;
        setTimeout(() => this.enqueue(ticketId), delay);
      } else {
        await this.prisma.ticket.update({
          where: { id: ticketId },
          data: { status: 'failed', attempts, lastError: message },
        });
      }
    }
  }
}
