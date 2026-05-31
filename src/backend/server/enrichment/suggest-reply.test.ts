// src/backend/server/enrichment/suggest-reply.test.ts
import { describe, it, expect } from 'vitest';
import { buildReplySuggestionPrompt } from './suggest-reply';

describe('buildReplySuggestionPrompt', () => {
  it('includes product name, review text, and extracted aspects', () => {
    const p = buildReplySuggestionPrompt({
      productName: 'حذاء الجري',
      reviewText: 'منتج رائع',
      stars: 5,
      aspects: [{ name: 'خفة الوزن', sentiment: 'positive' }],
    });
    expect(p).toContain('حذاء الجري');
    expect(p).toContain('منتج رائع');
    expect(p).toContain('خفة الوزن');
  });

  it('works when there are no aspects', () => {
    const p = buildReplySuggestionPrompt({ productName: 'منتج', reviewText: 'جيد', stars: 4, aspects: [] });
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(0);
  });
});
