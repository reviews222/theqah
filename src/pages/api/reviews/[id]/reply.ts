// src/pages/api/reviews/[id]/reply.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { dbAdmin } from '@/lib/firebaseAdmin';
import { requireUser } from '@/server/auth/requireUser';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const db = dbAdmin();
  const { id } = req.query as { id: string };

  if (req.method === 'GET') {
    const replies = await db.collection('reviews').doc(id).collection('replies')
      .where('visibility', '==', 'public')
      .orderBy('createdAt', 'asc').get();
    return res.json({ ok: true, items: replies.docs.map((d) => d.data()) });
  }

  if (req.method === 'POST') {
    try {
      const { uid } = await requireUser(req);
      const { text } = (req.body || {}) as { text?: string };
      const t = String(text || '').trim();
      if (!t) return res.status(400).json({ ok: false, error: 'text_required' });

      const reviewRef = db.collection('reviews').doc(id);
      const reviewSnap = await reviewRef.get();
      if (!reviewSnap.exists) return res.status(404).json({ ok: false, error: 'review_not_found' });

      const review = reviewSnap.data() as { storeUid?: string };
      if (review.storeUid !== uid) return res.status(403).json({ ok: false, error: 'forbidden' });

      const replyRef = reviewRef.collection('replies').doc();
      await replyRef.set({
        id: replyRef.id,
        reviewId: id,
        storeUid: uid,
        text: t.slice(0, 2000),
        visibility: 'public',
        createdAt: Date.now(),
      });
      await reviewRef.set({ lastRepliedAt: Date.now() }, { merge: true });

      return res.json({ ok: true, id: replyRef.id });
    } catch (e) {
      const msg = String(e || '');
      const code = msg.includes('unauthenticated') || msg.includes('unauthorized') ? 401 : 500;
      return res.status(code).json({ ok: false, error: code === 401 ? 'unauthorized' : 'server_error' });
    }
  }

  return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}
