// src/pages/api/cron/refresh-consensus.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { dbAdmin } from '@/lib/firebaseAdmin';
import { RepositoryFactory } from '@/server/repositories';
import { ConsensusRepository } from '@/server/repositories/consensus.repository';
import { generateConsensusText, shouldRegenerate } from '@/server/enrichment/build-consensus';

export const config = { maxDuration: 300 };

const MAX_PRODUCTS_PER_RUN = 40;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Find distinct (storeUid, productId) pairs among recently-published verified reviews.
  const snap = await dbAdmin().collection('reviews')
    .where('verified', '==', true)
    .where('status', '==', 'approved')
    .orderBy('publishedAt', 'desc')
    .limit(300)
    .get();

  const seen = new Set<string>();
  const pairs: Array<{ storeUid: string; productId: string }> = [];
  for (const doc of snap.docs) {
    const d = doc.data() as { storeUid?: string; productId?: string };
    if (!d.storeUid || !d.productId) continue;
    const key = `${d.storeUid}__${d.productId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ storeUid: d.storeUid, productId: d.productId });
    if (pairs.length >= MAX_PRODUCTS_PER_RUN) break; // bounded per run; remainder picked up next tick
  }

  const reviewRepo = RepositoryFactory.getReviewRepository();
  const consensusRepo = new ConsensusRepository();
  let generated = 0;

  for (const p of pairs) {
    try {
      const reviews = await reviewRepo.findVerifiedByStore(p.storeUid, p.productId, 50);
      const existing = await consensusRepo.get(p.storeUid, p.productId);
      if (!shouldRegenerate(existing, reviews.length)) continue;

      const productName = reviews[0]?.productName || 'هذا المنتج';
      const text = await generateConsensusText(
        productName,
        reviews.map((r) => ({ stars: r.stars, text: r.text })),
      );
      if (!text) continue;

      await consensusRepo.save({
        storeUid: p.storeUid,
        productId: p.productId,
        productName,
        text,
        basedOnCount: reviews.length,
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        generatedAt: Date.now(),
      });
      generated++;
    } catch (e) {
      console.error('[refresh-consensus] failed for', p.storeUid, p.productId, e instanceof Error ? e.message : String(e));
    }
  }

  return res.status(200).json({ ok: true, scannedDistinct: seen.size, candidates: pairs.length, generated });
}
