/**
 * Core types for the layered architecture
 * @module server/core/types
 */

/** Base interface for all entities with common fields */
export interface EntityBase {
    id?: string;
    createdAt?: number;
    updatedAt?: number;
}

/** Pagination options for list queries */
export interface PaginationOptions {
    limit?: number;
    offset?: number;
    startAfter?: string;
    orderBy?: string;
    orderDirection?: 'asc' | 'desc';
}

/** Paginated result wrapper */
export interface PaginatedResult<T> {
    data: T[];
    total?: number;
    hasMore: boolean;
    nextCursor?: string;
}

/** Review entity - matches current Firebase structure */
export interface Review extends EntityBase {
    reviewId: string;
    storeUid: string;
    platform?: 'salla' | 'zid' | 'manual';
    orderId: string;
    orderNumber: string;
    productId: string;
    productName: string;
    source: string;
    stars: number;
    text: string;
    author: {
        displayName: string;
        email?: string;
        mobile?: string;
    };
    status: string;
    trustedBuyer: boolean;
    verified: boolean;
    publishedAt: number;
    needsSallaId: boolean;
    sallaReviewId?: string;
    zidReviewId?: string;
    moderation?: {
        flagged: boolean;
        flags: string[];
        checkedAt: number;
    };
    enrichment?: {
        aspects: Array<{ name: string; sentiment: 'positive' | 'neutral' | 'negative'; quote?: string }>;
        topics: string[];
        sentiment: 'positive' | 'neutral' | 'negative';
        model: string;
        extractedAt: number;
    };
    needsEnrichment?: boolean;
}

/** Store entity */
export interface Store extends EntityBase {
    uid: string;
    provider: string;
    salla?: {
        uid: string;
        storeId: string;
        connected: boolean;
        installed: boolean;
        domain?: string;
    };
    zid?: {
        storeId: string;
        connected: boolean;
        installed: boolean;
        domain?: string;
    };
    domain?: {
        base: string;
        key: string;
        updatedAt: number;
    };
    subscription?: {
        planId: string;
        startedAt?: number;
        expiresAt?: number;
        expiredAt?: number;
        syncedAt: number;
        raw?: object;
        updatedAt?: number;
    };
    plan?: {
        code: string;
        active: boolean;
        expiredAt?: number;
        updatedAt: number;
    };
    meta?: {
        userinfo?: object;
    };
}

/** Order entity */
export interface Order extends EntityBase {
    number: string | null;
    status: string;
    paymentStatus: string;
    customer?: {
        name: string | null;
        email: string | null;
        mobile: string | null;
    };
    storeUid: string | null;
    platform: string;
}

/** Owner entity (OAuth tokens) */
export interface Owner extends EntityBase {
    uid: string;
    provider: string;
    oauth: {
        access_token: string;
        refresh_token?: string;
        scope?: string;
        expires?: number;
        receivedAt: number;
        strategy: string;
    };
}

/** Domain entity */
export interface Domain extends EntityBase {
    base: string;
    key: string;
    uid: string;
    storeUid: string;
    provider: string;
}

/** Review status types */
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'pending_review' | 'hidden';

/** Service result wrapper for operations that can fail */
export interface ServiceResult<T> {
    ok: boolean;
    data?: T;
    error?: string;
    code?: string;
}
