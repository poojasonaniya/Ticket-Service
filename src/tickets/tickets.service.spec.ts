import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TicketsService } from './tickets.service';

function makePrismaMock() {
  return {
    ticket: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };
}

function makeQueueMock() {
  return { enqueue: jest.fn() };
}

describe('TicketsService', () => {
  describe('create', () => {
    it('creates a new ticket and enqueues classification', async () => {
      const prisma = makePrismaMock();
      const queue = makeQueueMock();
      prisma.ticket.findUnique.mockResolvedValue(null);
      const created = { id: 't-1', status: 'pending' };
      prisma.ticket.create.mockResolvedValue(created);

      const service = new TicketsService(prisma as any, queue as any);
      const result = await service.create({
        id: 't-1',
        subject: 's',
        body: 'b',
      });

      expect(result).toEqual({ ticket: created, created: true });
      expect(queue.enqueue).toHaveBeenCalledWith('t-1');
    });

    it('is idempotent: a duplicate id returns the existing ticket without re-enqueuing', async () => {
      const prisma = makePrismaMock();
      const queue = makeQueueMock();
      const existing = { id: 't-1', status: 'classified' };
      prisma.ticket.findUnique.mockResolvedValue(existing);

      const service = new TicketsService(prisma as any, queue as any);
      const result = await service.create({
        id: 't-1',
        subject: 's',
        body: 'b',
      });

      expect(result).toEqual({ ticket: existing, created: false });
      expect(prisma.ticket.create).not.toHaveBeenCalled();
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('handles two concurrent creates for the same new id without duplicating or re-enqueuing', async () => {
      const prisma = makePrismaMock();
      const queue = makeQueueMock();
      prisma.ticket.findUnique.mockResolvedValue(null);
      const raceError = new Prisma.PrismaClientKnownRequestError(
        'unique constraint',
        {
          code: 'P2002',
          clientVersion: '5.0.0',
        },
      );
      prisma.ticket.create.mockRejectedValue(raceError);
      const existing = { id: 't-1', status: 'pending' };
      prisma.ticket.findUniqueOrThrow.mockResolvedValue(existing);

      const service = new TicketsService(prisma as any, queue as any);
      const result = await service.create({
        id: 't-1',
        subject: 's',
        body: 'b',
      });

      expect(result).toEqual({ ticket: existing, created: false });
      expect(queue.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('throws NotFoundException when the ticket does not exist', async () => {
      const prisma = makePrismaMock();
      prisma.ticket.findUnique.mockResolvedValue(null);
      const service = new TicketsService(prisma as any, makeQueueMock() as any);

      await expect(service.findOne('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns the ticket when it exists', async () => {
      const prisma = makePrismaMock();
      const ticket = { id: 't-1' };
      prisma.ticket.findUnique.mockResolvedValue(ticket);
      const service = new TicketsService(prisma as any, makeQueueMock() as any);

      await expect(service.findOne('t-1')).resolves.toBe(ticket);
    });
  });

  describe('findMany', () => {
    it('filters by category/priority and paginates', async () => {
      const prisma = makePrismaMock();
      prisma.ticket.findMany.mockResolvedValue([{ id: 't-1' }]);
      prisma.ticket.count.mockResolvedValue(1);
      const service = new TicketsService(prisma as any, makeQueueMock() as any);

      const result = await service.findMany({
        category: 'billing',
        priority: 'high',
        page: 2,
        pageSize: 5,
      });

      expect(prisma.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { category: 'billing', priority: 'high' },
          skip: 5,
          take: 5,
        }),
      );
      expect(result).toEqual({
        data: [{ id: 't-1' }],
        page: 2,
        pageSize: 5,
        total: 1,
      });
    });

    it('defaults to page 1 / pageSize 20 with no filters', async () => {
      const prisma = makePrismaMock();
      prisma.ticket.findMany.mockResolvedValue([]);
      prisma.ticket.count.mockResolvedValue(0);
      const service = new TicketsService(prisma as any, makeQueueMock() as any);

      await service.findMany({});

      expect(prisma.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {}, skip: 0, take: 20 }),
      );
    });
  });

  describe('reclassify', () => {
    it('throws NotFoundException when the ticket does not exist', async () => {
      const prisma = makePrismaMock();
      prisma.ticket.findUnique.mockResolvedValue(null);
      const service = new TicketsService(prisma as any, makeQueueMock() as any);

      await expect(service.reclassify('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it.each(['pending', 'processing'])(
      'refuses to reclassify a ticket that is already %s',
      async (status) => {
        const prisma = makePrismaMock();
        prisma.ticket.findUnique.mockResolvedValue({ id: 't-1', status });
        const service = new TicketsService(
          prisma as any,
          makeQueueMock() as any,
        );

        await expect(service.reclassify('t-1')).rejects.toThrow(
          ConflictException,
        );
      },
    );

    it.each(['classified', 'failed'])(
      'resets and re-enqueues a %s ticket',
      async (status) => {
        const prisma = makePrismaMock();
        const queue = makeQueueMock();
        prisma.ticket.findUnique.mockResolvedValue({ id: 't-1', status });
        const updated = { id: 't-1', status: 'pending', attempts: 0 };
        prisma.ticket.update.mockResolvedValue(updated);

        const service = new TicketsService(prisma as any, queue as any);
        const result = await service.reclassify('t-1');

        expect(prisma.ticket.update).toHaveBeenCalledWith({
          where: { id: 't-1' },
          data: { status: 'pending', attempts: 0, lastError: null },
        });
        expect(queue.enqueue).toHaveBeenCalledWith('t-1');
        expect(result).toBe(updated);
      },
    );
  });
});
