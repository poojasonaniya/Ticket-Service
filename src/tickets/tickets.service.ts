import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Ticket } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ClassificationQueueService } from '../classification/classification-queue.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { ListTicketsQueryDto } from './dto/list-tickets-query.dto';

export interface PaginatedTickets {
  data: Ticket[];
  page: number;
  pageSize: number;
  total: number;
}

const IN_FLIGHT_STATUSES = ['pending', 'processing'];

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ClassificationQueueService,
  ) {}

  // idempotent on id, resubmitting the same id just returns what's already
  // there, no re-classify. findUnique covers the normal case, the catch
  // below covers two requests racing to create the same new id
  async create(
    dto: CreateTicketDto,
  ): Promise<{ ticket: Ticket; created: boolean }> {
    const existing = await this.prisma.ticket.findUnique({
      where: { id: dto.id },
    });
    if (existing) {
      return { ticket: existing, created: false };
    }

    try {
      const ticket = await this.prisma.ticket.create({
        data: {
          id: dto.id,
          subject: dto.subject,
          body: dto.body,
          status: 'pending',
        },
      });
      this.queue.enqueue(ticket.id);
      return { ticket, created: true };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const raced = await this.prisma.ticket.findUniqueOrThrow({
          where: { id: dto.id },
        });
        return { ticket: raced, created: false };
      }
      throw err;
    }
  }

  async findOne(id: string): Promise<Ticket> {
    const ticket = await this.prisma.ticket.findUnique({ where: { id } });
    if (!ticket) {
      throw new NotFoundException(`ticket ${id} not found`);
    }
    return ticket;
  }

  async findMany(query: ListTicketsQueryDto): Promise<PaginatedTickets> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.TicketWhereInput = {
      ...(query.category ? { category: query.category } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.ticket.count({ where }),
    ]);

    return { data, page, pageSize, total };
  }

  // re-run classification for a ticket that failed, or that was classified
  // under an old prompt/heuristic. refuse if it's already in flight, it'll
  // get to classified/failed on its own
  async reclassify(id: string): Promise<Ticket> {
    const ticket = await this.prisma.ticket.findUnique({ where: { id } });
    if (!ticket) {
      throw new NotFoundException(`ticket ${id} not found`);
    }
    if (IN_FLIGHT_STATUSES.includes(ticket.status)) {
      throw new ConflictException(
        `ticket ${id} is already queued for classification`,
      );
    }

    const updated = await this.prisma.ticket.update({
      where: { id },
      data: { status: 'pending', attempts: 0, lastError: null },
    });
    this.queue.enqueue(id);
    return updated;
  }
}
