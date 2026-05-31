// src/pages/api/cron/enrich-reviews.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { RepositoryFactory } from '@/server/repositories';
import { extractAspects } from '@/server/enrichment/extract-aspects';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const repo = RepositoryFactory.getReviewRepository();
  const batch = await repo.findNeedingEnrichment(25);
  let done = 0;

  for (const review of batch) {
    if (!review.text?.trim()) {
      await repo.saveEnrichment(review.reviewId, {
        aspects: [], topics: [], sentiment: 'neutral',
        model: 'skip-empty', extractedAt: Date.now(),
      });
      continue;
    }
    const enrichment = await extractAspects({ text: review.text, stars: review.stars });
    if (enrichment) {
      await repo.saveEnrichment(review.reviewId, {
        ...enrichment,
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        extractedAt: Date.now(),
      });
      done++;
    }
  }

  return res.status(200).json({ ok: true, scanned: batch.length, enriched: done });
}
