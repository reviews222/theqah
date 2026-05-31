/**
 * Review repository
 * @module server/repositories/review.repository
 */

import { BaseRepository } from './base.repository';
import type { Review, PaginatedResult, PaginationOptions } from '../core/types';

export class ReviewRepository extends BaseRepository<Review> {
    protected readonly collectionName = 'reviews';
    protected readonly idField = 'reviewId';

    /**
     * Find review by order ID
     */
    async findByOrderId(orderId: string): Promise<Review | null> {
        return this.query()
            .where('orderId', '==', orderId)
            .getFirst();
    }

    /**
     * Find review by order and product
     */
    async findByOrderAndProduct(orderId: string, productId: string): Promise<Review | null> {
        return this.query()
            .where('orderId', '==', orderId)
            .where('productId', '==', productId)
            .getFirst();
    }

    /**
     * Find verified reviews for a store (for widget API).
     *
     * Performance note: stores with thousands of verified reviews
     * (e.g. backfilled merchants) made the unbounded variant of this
     * call serialize ~1600 docs over the wire on every page render.
     * `limit` caps the page size; the caller should use
     * `countVerifiedByStore` for the true total when displaying
     * "X verified reviews" badges.
     */
    async findVerifiedByStore(
        storeUid: string,
        productId?: string,
        limit?: number,
        offset?: number,
    ): Promise<Review[]> {
        // Bypass the FirestoreQueryBuilder for offset support — the
        // builder doesn't expose .offset() and we don't want to expand
        // its surface area for one caller. Direct Admin SDK query.
        const { dbAdmin } = await import('@/lib/firebaseAdmin');
        const db = dbAdmin();
        let q: FirebaseFirestore.Query = db.collection(this.collectionName)
            .where('storeUid', '==', storeUid)
            .where('verified', '==', true)
            .where('status', '==', 'approved');
        if (productId) q = q.where('productId', '==', productId);
        if (offset !== undefined && offset > 0) q = q.offset(offset);
        if (limit !== undefined) q = q.limit(limit);

        const snap = await q.get();
        return snap.docs.map((doc) => {
            const data = doc.data() as Record<string, unknown>;
            return { ...(data as object), id: doc.id, [this.idField]: doc.id } as unknown as Review;
        });
    }

    /**
     * Find which page (1-indexed) of `findVerifiedByStore` contains the
     * review with `targetReviewId`. Returns null if the review doesn't
     * exist or isn't verified/approved for this store.
     *
     * Used by the public `/api/public/store-profile` endpoint so that
     * deep-link share URLs (e.g. `/reviews?review=X`) can land on the
     * page that actually contains the focused review — otherwise the
     * SSR would always fetch page 1 and miss reviews further down.
     *
     * Cost: 1 doc read + 1 COUNT aggregation. The aggregation matches
     * the implicit `__name__` ordering used by findVerifiedByStore so
     * indexes stay consistent.
     */
    async findVerifiedReviewPage(
        storeUid: string,
        targetReviewId: string,
        pageSize: number,
    ): Promise<number | null> {
        if (pageSize <= 0) return null;
        const { dbAdmin } = await import('@/lib/firebaseAdmin');
        const { FieldPath } = await import('firebase-admin/firestore');
        const db = dbAdmin();
        const targetRef = db.collection(this.collectionName).doc(targetReviewId);
        const targetDoc = await targetRef.get();
        if (!targetDoc.exists) return null;
        const data = targetDoc.data() as Record<string, unknown> | undefined;
        if (!data) return null;
        // Only count if the target review actually belongs to this
        // store's verified+approved set; otherwise the page number we'd
        // return would be meaningless.
        if (data.storeUid !== storeUid || data.verified !== true || data.status !== 'approved') {
            return null;
        }
        const beforeQuery = db.collection(this.collectionName)
            .where('storeUid', '==', storeUid)
            .where('verified', '==', true)
            .where('status', '==', 'approved')
            .orderBy(FieldPath.documentId())
            .endBefore(targetDoc);
        const countSnap = await beforeQuery.count().get();
        const index = countSnap.data().count;
        return Math.floor(index / pageSize) + 1;
    }

    /**
     * Find the best published 5-star customer reviews across ALL stores
     * (independent of whether the store reviewed the app itself on Salla).
     * Used by the landing page's "real customer reviews" marquee.
     *
     * Diversity strategy: caps at `perStoreCap` reviews per store so no single
     * busy store can crowd out the wall. After sorting by recency and applying
     * the cap, the result represents the broadest cross-section of stores that
     * a 20-card marquee can show.
     *
     * Index strategy: only `status === 'approved'` is server-filtered
     * (single-field auto-index). Stars/verified/text and the per-store cap are
     * applied in-memory, which avoids needing a composite index.
     */
    async findTopReviews(limit: number = 20, perStoreCap: number = 2): Promise<Review[]> {
        // Fetch ALL approved reviews so every store using the app gets a fair
        // shot at the marquee. Also pre-fetch the set of currently-active
        // subscribed stores so we only feature reviews from stores that are
        // *still* using the app — lapsed/inactive stores don't belong in our
        // marketing wall.
        //
        // Both queries run in parallel. Safety ceiling of 10k prevents a
        // runaway scan if the dataset ever grows huge.
        const { dbAdmin } = await import('@/lib/firebaseAdmin');
        const { isStoreSubscriptionActive } = await import('../services/admin.service');
        const db = dbAdmin();
        const safetyCeiling = 10000;

        const [reviewsSnap, activeStoresSnap] = await Promise.all([
            this.collection.where('status', '==', 'approved').limit(safetyCeiling).get(),
            db.collection('stores').where('plan.active', '==', true).get(),
        ]);

        // Filter out stores whose subscription is technically expired even
        // though `plan.active` is still true (stale data from missed
        // deactivation webhooks).
        const activeStoreUids = new Set(
            activeStoresSnap.docs
                .filter((d) => isStoreSubscriptionActive(d.data() as Record<string, unknown>))
                .map((d) => d.id)
        );

        const rows = reviewsSnap.docs
            .map((doc) => this.mapDoc(doc))
            .filter((r) =>
                r.verified === true &&
                r.stars === 5 &&
                !!r.text && r.text.trim().length > 0 &&
                activeStoreUids.has(r.storeUid)
            );

        // Sort by recency so each store's freshest reviews bubble to the top
        // before the per-store cap kicks in.
        rows.sort((a, b) => (b.publishedAt || b.createdAt || 0) - (a.publishedAt || a.createdAt || 0));

        // Per-store cap: walk the sorted list, keep ≤ perStoreCap from each
        // store. NO backfill — if only a few stores have qualifying reviews,
        // the marquee will simply be shorter. Strict cap > artificial padding.
        const perStoreSeen: Record<string, number> = {};
        const picked: Review[] = [];
        for (const r of rows) {
            const count = perStoreSeen[r.storeUid] || 0;
            if (count >= perStoreCap) continue;
            perStoreSeen[r.storeUid] = count + 1;
            picked.push(r);
            if (picked.length >= limit) break;
        }

        return picked;
    }

    /**
     * Count all verified, approved reviews across every store using the app.
     * Used by the landing page social-proof strip to show the running total.
     * Server-side count aggregate — no documents are read.
     */
    async countAllVerified(): Promise<number> {
        const { dbAdmin } = await import('@/lib/firebaseAdmin');
        const db = dbAdmin();
        const snap = await db.collection(this.collectionName)
            .where('verified', '==', true)
            .where('status', '==', 'approved')
            .count().get();
        return snap.data().count;
    }

    /**
     * Count verified reviews for a store via Firestore aggregation
     * — does not read documents, fast even for thousands of reviews.
     */
    async countVerifiedByStore(storeUid: string, productId?: string): Promise<number> {
        const { dbAdmin } = await import('@/lib/firebaseAdmin');
        const db = dbAdmin();
        let q: FirebaseFirestore.Query = db.collection(this.collectionName)
            .where('storeUid', '==', storeUid)
            .where('verified', '==', true)
            .where('status', '==', 'approved');
        if (productId) q = q.where('productId', '==', productId);
        const snap = await q.count().get();
        return snap.data().count;
    }

    /**
     * Find reviews needing Salla ID (for backfill cron)
     */
    async findNeedingSallaId(limit: number = 50): Promise<Review[]> {
        return this.query()
            .where('needsSallaId', '==', true)
            .limit(limit)
            .getAll();
    }

    /** Persist extracted enrichment and clear the needsEnrichment flag. */
    async saveEnrichment(
        reviewId: string,
        enrichment: NonNullable<Review['enrichment']>,
    ): Promise<void> {
        await this.update(reviewId, {
            enrichment,
            needsEnrichment: false,
        } as Partial<Review>);
    }

    /** Reviews flagged for enrichment backfill. */
    async findNeedingEnrichment(limit: number = 50): Promise<Review[]> {
        return this.query()
            .where('needsEnrichment', '==', true)
            .limit(limit)
            .getAll();
    }

    /**
     * Update Salla review ID
     */
    async updateSallaId(reviewId: string, sallaReviewId: string): Promise<void> {
        await this.update(reviewId, {
            sallaReviewId,
            needsSallaId: false,
            verified: true,
            backfilledAt: new Date().toISOString(),
        } as Partial<Review>);
    }

    /**
     * Increment backfill attempt counter; if max reached, mark as failed.
     */
    async incrementBackfillAttempt(reviewId: string, maxAttempts: number): Promise<{ gaveUp: boolean; attempts: number }> {
        const review = await this.findById(reviewId);
        if (!review) return { gaveUp: false, attempts: 0 };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- backfillAttempts is a dynamic field not in the Review type
        const attempts = ((review as any).backfillAttempts ?? 0) + 1;
        if (attempts >= maxAttempts) {
            await this.update(reviewId, {
                needsSallaId: false,
                backfillFailed: true,
                backfillAttempts: attempts,
                backfillGivenUpAt: new Date().toISOString(),
            } as Partial<Review>);
            return { gaveUp: true, attempts };
        }

        await this.update(reviewId, {
            backfillAttempts: attempts,
        } as Partial<Review>);
        return { gaveUp: false, attempts };
    }

    /**
     * Find reviews by store with pagination
     */
    async findByStoreUid(
        storeUid: string,
        options?: PaginationOptions
    ): Promise<PaginatedResult<Review>> {
        return this.query()
            .where('storeUid', '==', storeUid)
            .orderBy('createdAt', 'desc')
            .getPaginated(options);
    }

    /**
     * Find pending reviews for a store
     */
    async findPendingReviews(storeUid: string): Promise<Review[]> {
        return this.query()
            .where('storeUid', '==', storeUid)
            .where('status', '==', 'pending_review')
            .getAll();
    }

    /**
     * Update review status
     */
    async updateStatus(id: string, status: string, published: boolean): Promise<void> {
        await this.update(id, {
            status,
            published,
            publishedAt: published ? Date.now() : null,
        } as unknown as Partial<Review>);
    }

    /**
     * Hide a review
     */
    async hide(id: string): Promise<void> {
        await this.update(id, {
            status: 'hidden',
            published: false,
        } as unknown as Partial<Review>);
    }

    /**
     * Find published reviews for public widget API
     */
    async findPublishedByStore(
        storeUid: string,
        options?: {
            productId?: string;
            limit?: number;
            sort?: 'asc' | 'desc';
            sinceDays?: number;
        }
    ): Promise<Review[]> {
        const { productId, limit = 20, sort = 'desc', sinceDays = 0 } = options || {};

        const snapshot = await this.collection
            .where('storeUid', '==', storeUid)
            .where('status', '==', 'published')
            .orderBy('publishedAt', sort)
            .limit(limit)
            .get();

        let reviews = snapshot.docs.map(doc => this.mapDoc(doc));

        // Filter by productId if provided
        if (productId) {
            reviews = reviews.filter(r => r.productId === productId);
        }

        // Filter by sinceDays if provided
        if (sinceDays > 0) {
            const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
            reviews = reviews.filter(r => (r.publishedAt || 0) >= cutoff);
        }

        return reviews;
    }
}

