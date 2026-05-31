// src/backend/server/repositories/consensus.repository.ts
import { dbAdmin } from '@/lib/firebaseAdmin';

export interface ConsensusDoc {
  storeUid: string;
  productId: string;
  productName: string;
  text: string;
  basedOnCount: number;
  model: string;
  generatedAt: number;
}

const COLLECTION = 'review_consensus';

/** Stable doc id: one consensus per store+product. */
export function consensusDocId(storeUid: string, productId: string): string {
  return `${storeUid}__${productId || 'store'}`;
}

export class ConsensusRepository {
  async get(storeUid: string, productId: string): Promise<ConsensusDoc | null> {
    const snap = await dbAdmin().collection(COLLECTION).doc(consensusDocId(storeUid, productId)).get();
    return snap.exists ? (snap.data() as ConsensusDoc) : null;
  }

  async save(doc: ConsensusDoc): Promise<void> {
    await dbAdmin()
      .collection(COLLECTION)
      .doc(consensusDocId(doc.storeUid, doc.productId))
      .set(doc, { merge: true });
  }
}
