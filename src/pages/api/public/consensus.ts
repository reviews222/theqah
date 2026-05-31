// src/pages/api/public/consensus.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { rateLimitPublic, RateLimitPresets } from '@/server/rate-limit-public';
import { ConsensusRepository } from '@/server/repositories/consensus.repository';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-theqah-widget');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).end();
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const limited = await rateLimitPublic(req, res, {
    ...RateLimitPresets.PUBLIC_MODERATE,
    identifier: 'public-consensus',
  });
  if (limited) return;

  const get = (k: string) => {
    const v = req.query[k];
    return typeof v === 'string' ? v : Array.isArray(v) ? v[0] || '' : '';
  };
  const storeUid = get('storeUid') || get('store') || get('s');
  const productId = get('productId') || get('product') || get('p');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900');

  if (!storeUid || !productId) return res.status(200).json({ consensus: null });

  try {
    const doc = await new ConsensusRepository().get(storeUid, productId);
    return res.status(200).json({
      consensus: doc ? { text: doc.text, basedOnCount: doc.basedOnCount, generatedAt: doc.generatedAt } : null,
    });
  } catch (e) {
    console.error('[public/consensus] failed:', e instanceof Error ? e.message : String(e));
    return res.status(200).json({ consensus: null });
  }
}
