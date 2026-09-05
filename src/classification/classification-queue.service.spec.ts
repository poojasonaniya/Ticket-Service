import { ConfigService } from '@nestjs/config';
import { ClassificationQueueService } from './classification-queue.service';
import { LlmClient } from './llm-client.interface';

interface FakeTicket {
  id: string;
  subject: string;
  body: string;
  status: string;
  category: string | null;
  priority: string | null;
  summary: string | null;
  attempts: number;
  lastError: string | null;
}

function makeTicket(
  overrides: Partial<FakeTicket> & { id: string },
): FakeTicket {
  return {
    subject: 's',
    body: 'b',
    status: 'pending',
    category: null,
    priority: null,
    summary: null,
    attempts: 0,
    lastError: null,
    ...overrides,
  };
}

// bare-bones stand-in for PrismaService, just the bits the queue touches
function makePrismaMock(initial: FakeTicket[]) {
  const store = new Map(initial.map((t) => [t.id, { ...t } as FakeTicket]));

  return {
    ticket: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const t of store.values()) {
          if (where.id !== undefined && t.id !== where.id) continue;
          if (where.status !== undefined && t.status !== where.status) continue;
          Object.assign(t, data);
          count++;
        }
        return { count };
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const t = store.get(where.id);
        return t ? { ...t } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const t = store.get(where.id);
        if (!t) throw new Error('not found');
        Object.assign(t, data);
        return { ...t };
      }),
      findMany: jest.fn(async ({ where }: any) => {
        return Array.from(store.values())
          .filter((t) => (where?.status ? t.status === where.status : true))
          .map((t) => ({ id: t.id }));
      }),
    },
    __store: store,
  };
}

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    CLASSIFY_CONCURRENCY: '2',
    CLASSIFY_MAX_ATTEMPTS: '3',
    CLASSIFY_RETRY_BASE_MS: '10',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('ClassificationQueueService', () => {
  it('classifies a pending ticket and stores the validated result', async () => {
    const prisma = makePrismaMock([makeTicket({ id: 't-1' })]);
    const llm: LlmClient = {
      classify: jest.fn().mockResolvedValue(
        JSON.stringify({
          category: 'billing',
          priority: 'high',
          summary: 'x',
        }),
      ),
    };
    const queue = new ClassificationQueueService(
      prisma as any,
      llm,
      makeConfig(),
    );

    queue.enqueue('t-1');
    await flushMicrotasks();

    const stored = prisma.__store.get('t-1')!;
    expect(stored.status).toBe('classified');
    expect(stored.category).toBe('billing');
    expect(stored.priority).toBe('high');
    expect(stored.summary).toBe('x');
  });

  it('does not process a ticket that is not pending (claim race)', async () => {
    const prisma = makePrismaMock([
      makeTicket({ id: 't-1', status: 'classified' }),
    ]);
    const llm: LlmClient = { classify: jest.fn() };
    const queue = new ClassificationQueueService(
      prisma as any,
      llm,
      makeConfig(),
    );

    queue.enqueue('t-1');
    await flushMicrotasks();

    expect(llm.classify).not.toHaveBeenCalled();
  });

  it('retries on a malformed response and eventually marks the ticket failed', async () => {
    const prisma = makePrismaMock([makeTicket({ id: 't-1' })]);
    const llm: LlmClient = {
      classify: jest.fn().mockResolvedValue('not json'),
    };
    const queue = new ClassificationQueueService(
      prisma as any,
      llm,
      makeConfig({ CLASSIFY_MAX_ATTEMPTS: '2', CLASSIFY_RETRY_BASE_MS: '30' }),
    );

    queue.enqueue('t-1');
    await sleep(15);
    expect(prisma.__store.get('t-1')!.status).toBe('pending');
    expect(prisma.__store.get('t-1')!.attempts).toBe(1);

    // wait out the 30ms backoff, it should retry once more and then give up
    await sleep(100);

    expect(prisma.__store.get('t-1')!.status).toBe('failed');
    expect(prisma.__store.get('t-1')!.attempts).toBe(2);
    expect(llm.classify).toHaveBeenCalledTimes(2);
  });

  it('limits how many classifications run at once', async () => {
    const prisma = makePrismaMock([
      makeTicket({ id: 't-1' }),
      makeTicket({ id: 't-2' }),
    ]);
    let resolveFirst!: (raw: string) => void;
    const firstResult = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const validResponse = JSON.stringify({
      category: 'other',
      priority: 'low',
      summary: 'x',
    });

    const classify = jest
      .fn()
      .mockImplementationOnce(() => firstResult)
      .mockResolvedValueOnce(validResponse);
    const llm: LlmClient = { classify };
    const queue = new ClassificationQueueService(
      prisma as any,
      llm,
      makeConfig({ CLASSIFY_CONCURRENCY: '1' }),
    );

    queue.enqueue('t-1');
    queue.enqueue('t-2');
    await flushMicrotasks();

    expect(classify).toHaveBeenCalledTimes(1);

    resolveFirst(validResponse);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(classify).toHaveBeenCalledTimes(2);
  });

  it('on bootstrap, resets interrupted tickets and requeues everything pending', async () => {
    const prisma = makePrismaMock([
      makeTicket({ id: 't-1', status: 'processing' }),
      makeTicket({ id: 't-2', status: 'pending' }),
      makeTicket({ id: 't-3', status: 'classified' }),
    ]);
    const llm: LlmClient = {
      classify: jest
        .fn()
        .mockResolvedValue(
          JSON.stringify({ category: 'other', priority: 'low', summary: 'x' }),
        ),
    };
    const queue = new ClassificationQueueService(
      prisma as any,
      llm,
      makeConfig(),
    );

    await queue.onApplicationBootstrap();
    await flushMicrotasks();

    expect(prisma.__store.get('t-1')!.status).toBe('classified');
    expect(prisma.__store.get('t-2')!.status).toBe('classified');
    expect(prisma.__store.get('t-3')!.status).toBe('classified');
    expect(llm.classify).toHaveBeenCalledTimes(2); // only t-1 and t-2 were reprocessed
  });
});

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
