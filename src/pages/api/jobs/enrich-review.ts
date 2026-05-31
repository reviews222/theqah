// src/pages/api/jobs/enrich-review.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { RepositoryFactory } from '@/server/repositories';
import { extractAspects } from '@/server/enrichment/extract-aspects';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { reviewDocId } = (req.body || {}) as { reviewDocId?: string };
  if (!reviewDocId) return res.status(400).json({ error: 'missing_reviewDocId' });

  // Respond immediately; process in background (mirrors fetch-review-id).
  res.status(202).json({ message: 'accepted' });

  try {
    const repo = RepositoryFactory.getReviewRepository();
    const review = await repo.findById(reviewDocId);
    if (!review) return;
    if (!review.text?.trim()) {
      await repo.saveEnrichment(reviewDocId, {
        aspects: [], topics: [], sentiment: 'neutral',
        model: 'skip-empty', extractedAt: Date.now(),
      });
      return;
    }

    const enrichment = await extractAspects({ text: review.text, stars: review.stars });
    if (!enrichment) return;

    await repo.saveEnrichment(reviewDocId, {
      ...enrichment,
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      extractedAt: Date.now(),
    });
  } catch (e) {
    console.error('[enrich-review] failed:', reviewDocId, e instanceof Error ? e.message : String(e));
  }
}
