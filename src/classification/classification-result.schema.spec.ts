import {
  InvalidClassificationError,
  parseClassificationResponse,
} from './classification-result.schema';

describe('parseClassificationResponse', () => {
  it('accepts a well-formed response', () => {
    const raw = JSON.stringify({
      category: 'billing',
      priority: 'high',
      summary: 'Customer was charged twice for one subscription.',
    });

    expect(parseClassificationResponse(raw)).toEqual({
      category: 'billing',
      priority: 'high',
      summary: 'Customer was charged twice for one subscription.',
    });
  });

  it('rejects text that is not JSON', () => {
    expect(() => parseClassificationResponse('sure, this is billing')).toThrow(
      InvalidClassificationError,
    );
  });

  it('rejects a category outside the allowed set', () => {
    const raw = JSON.stringify({
      category: 'spam',
      priority: 'high',
      summary: 'x',
    });
    expect(() => parseClassificationResponse(raw)).toThrow(
      InvalidClassificationError,
    );
  });

  it('rejects a priority outside the allowed set', () => {
    const raw = JSON.stringify({
      category: 'billing',
      priority: 'URGENT',
      summary: 'x',
    });
    expect(() => parseClassificationResponse(raw)).toThrow(
      InvalidClassificationError,
    );
  });

  it('rejects a response missing a required field', () => {
    const raw = JSON.stringify({ category: 'billing', priority: 'high' });
    expect(() => parseClassificationResponse(raw)).toThrow(
      InvalidClassificationError,
    );
  });

  it('rejects an empty summary', () => {
    const raw = JSON.stringify({
      category: 'billing',
      priority: 'high',
      summary: '   ',
    });
    expect(() => parseClassificationResponse(raw)).toThrow(
      InvalidClassificationError,
    );
  });

  it('rejects a summary that runs more than one sentence', () => {
    const raw = JSON.stringify({
      category: 'billing',
      priority: 'high',
      summary: 'Customer was charged twice. They want a refund.',
    });
    expect(() => parseClassificationResponse(raw)).toThrow(
      InvalidClassificationError,
    );
  });

  it('accepts a single sentence ending in ! or ? or ...', () => {
    for (const summary of [
      'Customer is very upset!',
      'Customer wants to know why they were charged twice?',
      'Customer trailed off mid-thought...',
      'Customer has no punctuation at all',
    ]) {
      const raw = JSON.stringify({ category: 'billing', priority: 'high', summary });
      expect(parseClassificationResponse(raw).summary).toBe(summary);
    }
  });

  it('carries the raw response on the error, for logging/debugging', () => {
    const raw = 'not json at all';
    try {
      parseClassificationResponse(raw);
      fail('expected parseClassificationResponse to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidClassificationError);
      expect((err as InvalidClassificationError).rawResponse).toBe(raw);
    }
  });
});
