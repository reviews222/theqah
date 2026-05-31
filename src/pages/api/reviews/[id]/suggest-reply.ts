// src/pages/api/reviews/[id]/suggest-reply.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { RepositoryFactory } from '@/server/repositories';
import { requireUser } from '@/server/auth/requireUser';
import { suggestReply } from '@/server/enrichment/suggest-reply';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const { id } = req.query as { id: string };

  try {
    const { uid } = await requireUser(req);
    const repo = RepositoryFactory.getReviewRepository();
    const review = await repo.findById(id);
    if (!review) return res.status(404).json({ ok: false, error: 'review_not_found' });
    if (review.storeUid !== uid) return res.status(403).json({ ok: false, error: 'forbidden' });

    const suggestion = await suggestReply({
      productName: review.productName || 'هذا المنتج',
      reviewText: review.text || '',
      stars: review.stars || 0,
      aspects: review.enrichment?.aspects?.map((a) => ({ name: a.name, sentiment: a.sentiment })) || [],
    });

    return res.status(200).json({ ok: true, suggestion: suggestion ?? null });
  } catch (e) {
    const msg = String(e || '');
    if (msg.includes('unauthenticated') || msg.includes('unauthorized')) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    console.error('[suggest-reply] failed:', msg);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}
