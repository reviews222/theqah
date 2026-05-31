/**
 * Salla webhook service - handles all Salla webhook events
 * @module server/services/salla-webhook.service
 */

import { RepositoryFactory } from '../repositories';
import type { Review } from '../core/types';

export interface SallaOrder {
    id?: string | number;
    reference_id?: string;
    order_id?: string;
    number?: string;
    status?: string;
    order_status?: string;
    new_status?: string;
    shipment_status?: string;
    payment_status?: string;
    customer?: {
        name?: string;
        email?: string;
        mobile?: string;
    };
    items?: Array<{ product_id?: string | number }>;
}

export interface SallaReviewPayload {
    id?: string | number;
    type?: string;
    content?: string;
    rating?: number;
    product?: {
        id?: string | number;
        name?: string;
    };
    order?: {
        id?: string | number;
        order_id?: string | number;
        reference_id?: string;
        date?: { date?: string };
    };
    customer?: {
        name?: string;
        email?: string;
        mobile?: string;
    };
}

export class SallaWebhookService {
    private reviewRepo = RepositoryFactory.getReviewRepository();
    private storeRepo = RepositoryFactory.getStoreRepository();
    private orderRepo = RepositoryFactory.getOrderRepository();
    private ownerRepo = RepositoryFactory.getOwnerRepository();
    private domainRepo = RepositoryFactory.getDomainRepository();

    /**
     * Handle app.store.authorize event
     */
    async handleAppAuthorize(
        storeUid: string,
        accessToken: string,
        refreshToken?: string,
        scope?: string,
        expires?: number
    ): Promise<void> {
        await this.ownerRepo.saveOAuth(storeUid, 'salla', {
            access_token: accessToken,
            refresh_token: refreshToken,
            scope,
            expires,
            strategy: 'easy_mode',
        });
    }

    /**
     * Handle subscription started/renewed events
     */
    async handleSubscriptionEvent(
        storeUid: string,
        planId: string,
        startedAt: number,
        expiresAt?: number | null,
        rawPayload?: object
    ): Promise<void> {
        await this.storeRepo.updateSubscription(storeUid, planId, startedAt, expiresAt, rawPayload);

        // Fire-and-forget historical review backfill enqueue. Idempotent —
        // duplicate webhook calls won't create duplicate jobs. A failure
        // here must NOT block subscription activation.
        try {
            const { dbAdmin } = await import('@/lib/firebaseAdmin');
            const { BackfillJobService } = await import('./backfill/backfill-job.service');
            await new BackfillJobService(dbAdmin()).enqueue({
                storeUid,
                platform: 'salla',
                source: 'webhook',
            });
        } catch (err) {
            console.error('[SallaWebhookService] backfill enqueue failed:', err);
        }
    }

    /**
     * Handle subscription expired/cancelled events
     */
    async handleSubscriptionExpired(storeUid: string, rawPayload?: object): Promise<void> {
        await this.storeRepo.deactivateSubscription(storeUid, rawPayload);
    }

    /**
     * Handle trial started event
     */
    async handleTrialStarted(
        storeUid: string,
        startedAt: number,
        expiresAt?: number | null,
        rawPayload?: object
    ): Promise<void> {
        await this.storeRepo.updateSubscription(storeUid, 'TRIAL', startedAt, expiresAt, rawPayload);

        // Trials are subscriptions for our purposes — merchants on TRIAL should
        // still see their historical Salla reviews backfilled, otherwise the
        // certificate widget shows zero verified reviews until trial→paid
        // conversion (which may never happen). Mirrors handleSubscriptionEvent.
        // Fire-and-forget + idempotent via BackfillJobService.enqueue dedupe.
        try {
            const { dbAdmin } = await import('@/lib/firebaseAdmin');
            const { BackfillJobService } = await import('./backfill/backfill-job.service');
            await new BackfillJobService(dbAdmin()).enqueue({
                storeUid,
                platform: 'salla',
                source: 'webhook',
            });
        } catch (err) {
            console.error('[SallaWebhookService] trial backfill enqueue failed:', err);
        }
    }

    /**
     * Handle order.created - save order snapshot
     */
    async handleOrderCreated(order: SallaOrder, storeUid: string): Promise<void> {
        const orderId = String(order.reference_id ?? order.id ?? order.order_id ?? '');
        if (!orderId) return;

        // Salla may return status as object {id, name, customized} or string
        const extractStatus = (status: unknown): string => {
            if (typeof status === 'string') return status.toLowerCase();
            if (status && typeof status === 'object' && 'name' in status) {
                return String((status as { name?: unknown }).name ?? '').toLowerCase();
            }
            return '';
        };

        await this.orderRepo.upsertSnapshot(orderId, {
            number: order.number || null,
            status: extractStatus(order.status ?? order.order_status),
            paymentStatus: extractStatus(order.payment_status),
            storeUid,
            platform: 'salla',
        });
    }

    /**
     * Handle review.added - save review from webhook with moderation
     */
    async handleReviewAdded(
        storeUid: string,
        merchantId: string,
        payload: SallaReviewPayload,
        subscriptionStart: number,
        options?: { appUrl?: string; cronSecret?: string }
    ): Promise<{ saved: boolean; docId?: string; skipped?: string; status?: string; flagged?: boolean }> {
        const product = payload.product;
        const order = payload.order;
        const customer = payload.customer;
        const reviewType = String(payload.type || '');

        // Skip testimonials (store reviews)
        if (reviewType === 'testimonial' || !product) {
            return { saved: false, skipped: 'testimonial_or_no_product' };
        }

        const productId = String(product.id || '');
        const sallaOrderId = String(order?.id || order?.order_id || '');
        const sallaReferenceId = String(order?.reference_id || '');
        const orderId = sallaOrderId || sallaReferenceId;

        if (!productId || !orderId) {
            return { saved: false, skipped: 'missing_product_or_order_id' };
        }

        // Check if already exists
        const existing = await this.reviewRepo.findByOrderAndProduct(orderId, productId);
        if (existing) {
            return { saved: false, skipped: 'already_exists' };
        }

        // Determine if verified based on subscription
        const orderDate = order?.date?.date
            ? new Date(order.date.date).getTime()
            : Date.now();
        const isVerified = subscriptionStart > 0 && orderDate >= subscriptionStart;

        // Create doc ID
        const docId = `salla_${merchantId}_order_${orderId}_product_${productId}`;

        // Content moderation
        const reviewText = String(payload.content || '');
        let reviewStatus = 'approved';
        let moderationFlags: string[] = [];
        let needsManualReview = false;

        if (reviewText.trim()) {
            try {
                const { moderateReview } = await import('../moderation');
                const modResult = await moderateReview({
                    text: reviewText,
                    stars: Number(payload.rating || 0),
                    costSaving: true // Use cost-saving mode for webhook (high volume)
                });

                if (!modResult.ok) {
                    reviewStatus = 'pending_review';
                    moderationFlags = modResult.flags || [];
                    needsManualReview = true;
                }
            } catch (modError) {
                console.error(`[SallaWebhookService] Moderation error for ${docId}:`, modError);
                // Continue without moderation if it fails
            }
        }

        // Build review document
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const reviewDoc: any = {
            reviewId: docId,
            storeUid,
            orderId: String(orderId),
            orderNumber: sallaReferenceId || String(orderId),
            productId: String(productId),
            productName: String(product.name || ''),
            source: 'salla_native',
            stars: Number(payload.rating || 0),
            text: reviewText,
            author: {
                displayName: String(customer?.name || 'عميل سلة'),
            },
            status: reviewStatus,
            trustedBuyer: false,
            verified: isVerified,
            publishedAt: orderDate,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            needsSallaId: true,
            needsEnrichment: true,
        };

        // Add moderation info if flagged
        if (needsManualReview) {
            reviewDoc.moderation = {
                flagged: true,
                flags: moderationFlags,
                checkedAt: Date.now(),
            };
        }

        await this.reviewRepo.createWithId(docId, reviewDoc);

        // Trigger background job to fetch sallaReviewId (fire-and-forget)
        if (options?.appUrl && options?.cronSecret) {
            this.triggerBackgroundJob(docId, merchantId, orderId, options.appUrl, options.cronSecret);
            this.triggerEnrichmentJob(docId, options.appUrl, options.cronSecret);
        }

        return { saved: true, docId, status: reviewStatus, flagged: needsManualReview };
    }

    /**
     * Trigger background job to fetch Salla review ID
     * Fire-and-forget - doesn't block the webhook response
     */
    private triggerBackgroundJob(
        docId: string,
        merchantId: string,
        orderId: string,
        appUrl: string,
        cronSecret: string
    ): void {
        const jobUrl = `${appUrl}/api/jobs/fetch-review-id`;

        fetch(jobUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${cronSecret}`,
            },
            body: JSON.stringify({
                reviewDocId: docId,
                merchantId,
                orderId,
            }),
        }).catch((err) => {
            console.error('[SallaWebhookService] Background job trigger failed:', err);
            // Non-blocking: job will be picked up by hourly cron backup
        });
    }


    /** Fire-and-forget enrichment job trigger. Non-blocking; cron backfill is the safety net. */
    private triggerEnrichmentJob(docId: string, appUrl: string, cronSecret: string): void {
        fetch(`${appUrl}/api/jobs/enrich-review`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cronSecret}` },
            body: JSON.stringify({ reviewDocId: docId }),
        }).catch((err) => console.error('[SallaWebhookService] enrichment trigger failed:', err));
    }

    /**
     * Backfill Salla review ID (called by cron)
     */
    async backfillReviewId(reviewId: string, sallaReviewId: string): Promise<boolean> {
        try {
            await this.reviewRepo.updateSallaId(reviewId, sallaReviewId);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get reviews needing Salla ID backfill
     */
    async getReviewsNeedingBackfill(limit: number = 50): Promise<Review[]> {
        return this.reviewRepo.findNeedingSallaId(limit);
    }

    /**
     * Save domain mapping
     */
    async saveDomain(storeUid: string, domain: string): Promise<void> {
        const key = domain
            .replace(/^https?:\/\//, '')
            .replace(/\//g, '_')
            .replace(/\./g, '_')
            .toLowerCase();

        await this.storeRepo.updateDomain(storeUid, domain, key);
        await this.domainRepo.saveDomainVariations(domain, storeUid);
    }

    /**
     * Save domain with store flags (connected, installed, etc.)
     * Replaces inline webhook function
     */
    async saveDomainWithFlags(
        storeUid: string,
        merchantId: string | number | null,
        domain: string | null | undefined,
        event: string
    ): Promise<void> {
        const now = Date.now();

        // Update store with connection flags
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storeUpdate: any = {
            uid: storeUid,
            provider: 'salla',
            updatedAt: now,
            salla: {
                uid: storeUid,
                storeId: merchantId ?? null,
                connected: true,
                installed: true,
                ...(domain ? { domain } : {}),
            },
        };

        if (domain) {
            const key = this.encodeUrl(domain);
            storeUpdate.domain = { base: domain, key, updatedAt: now };
        }

        // Use set with merge so it works for new stores too
        await this.storeRepo.set(storeUid, storeUpdate);

        // Save domain mapping if present
        if (domain) {
            await this.domainRepo.saveDomainVariations(domain, storeUid);
        }

        // Log event
        await this.logEvent(event, storeUid, 'domain_flags_saved', { domain });
    }

    /**
     * Save multiple domain format variations
     * Handles dev subdirectories and various URL formats
     */
    async saveDomainVariations(storeUid: string, originalDomain: string | null | undefined): Promise<void> {
        if (!originalDomain) return;

        // Normalize and save via domain repository
        await this.domainRepo.saveDomainVariations(originalDomain, storeUid);
    }

    /**
     * Save a custom domain (non-Salla domain) for a store
     * This is for stores that have their own domain like pointstylishes.com
     */
    async saveCustomDomain(storeUid: string, customDomain: string | null | undefined): Promise<void> {
        if (!customDomain) return;

        await this.domainRepo.saveCustomDomain(customDomain, storeUid);
    }


    /**
     * Helper to encode URL for Firestore document ID
     */
    private encodeUrl(url: string): string {
        return url
            .replace(/^https?:\/\//, '')
            .replace(/\//g, '_')
            .replace(/\./g, '_')
            .toLowerCase();
    }

    /**
     * Log Salla app event
     */
    private async logEvent(
        event: string,
        storeUid: string,
        type: string,
        meta?: Record<string, unknown>
    ): Promise<void> {
        try {
            const { dbAdmin } = await import('@/lib/firebaseAdmin');
            const db = dbAdmin();
            await db.collection('salla_app_events').add({
                at: Date.now(),
                event,
                type,
                uid: storeUid,
                ...meta,
            });
        } catch {
            // Silent fail for logging
        }
    }
}
