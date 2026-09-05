import { z } from 'zod';

export const CATEGORIES = ['billing', 'technical', 'account', 'other'] as const;
export const PRIORITIES = ['low', 'medium', 'high'] as const;

export type Category = (typeof CATEGORIES)[number];
export type Priority = (typeof PRIORITIES)[number];

export const ClassificationResultSchema = z.object({
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES),
  summary: z.string().trim().min(1).max(300),
});

export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;

// Not JSON, or JSON that doesn't match the allowed shape/enums. Whoever
// catches this decides what happens next (retry, fail) — point is bad data
// never reaches the store.
export class InvalidClassificationError extends Error {
  constructor(
    message: string,
    public readonly rawResponse: string,
  ) {
    super(message);
    this.name = 'InvalidClassificationError';
  }
}

export function parseClassificationResponse(raw: string): ClassificationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidClassificationError(
      'model response was not valid JSON',
      raw,
    );
  }

  const result = ClassificationResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new InvalidClassificationError(
      `model response failed schema validation: ${result.error.message}`,
      raw,
    );
  }

  return result.data;
}
