// src/pages/store/[storeUid]/certificate.tsx
//
// Public "certificate" view of a store's reviews — the page the
// certificate logo (widget footer) links to. This route exists to
// enforce a *server-side* star floor: unlike the prior implementation
// which used `/reviews?minStars=4` (bypassable by anyone editing the
// URL), the floor here is baked into the route itself. There is no
// query param to tamper with.
//
// The page component is reused from `./reviews` — only the data
// fetching (and the stars filter) differs. We additionally build the
// JSON-LD schema graph here so Google / LLM crawlers can recognize
// these reviews as independently-verified Triple-Match certificates,
// not raw merchant-supplied testimonials.

import type { GetServerSideProps } from "next";
import StoreReviewsPage, {
    fetchStoreReviewsProps,
    certCode,
    type StoreReviewsPageProps,
    type StoreProfile,
} from "./reviews";
import { buildCertificateSchema } from "@/lib/schema/buildCertificateSchema";
import { ConsensusRepository } from "@/server/repositories/consensus.repository";
import { dbAdmin } from "@/lib/firebaseAdmin";

/**
 * Minimum star rating required for a review to appear on the
 * certificate page. Must be enforced server-side — do not expose as
 * a query parameter.
 */
const CERTIFICATE_MIN_STARS = 4;

export const getServerSideProps: GetServerSideProps<StoreReviewsPageProps> = async (ctx) => {
    const result = await fetchStoreReviewsProps(ctx, { redirectBase: "/certificate" });

    // Redirects and error-prop responses pass through untouched — we only
    // need to post-process the success case where we actually got a profile.
    if ("redirect" in result || "notFound" in result) {
        return result;
    }

    const props = await Promise.resolve(result.props);
    if (!props.profile) {
        return { props };
    }

    const filteredProfile: StoreProfile = {
        ...props.profile,
        reviews: props.profile.reviews.filter((r) => r.stars >= CERTIFICATE_MIN_STARS),
    };

    // Skip JSON-LD entirely for stores with no verified reviews. Emitting an
    // AggregateRating with ratingValue=0 / reviewCount=0 fails Google's Rich
    // Results validator and provides no SEO value. The page still renders
    // (showing an empty state) — only the schema graph is suppressed.
    if (filteredProfile.stats.totalReviews === 0) {
        return {
            props: {
                ...props,
                profile: filteredProfile,
            },
        };
    }

    // Build JSON-LD using the API's verified-only stats (NOT the >=4 filter,
    // since the cosmetic display floor != verification floor — every review
    // returned by the API is already Triple-Match verified).
    const lastUpdateMs = filteredProfile.reviews.reduce(
        (max, r) => Math.max(max, r.publishedAt),
        0,
    );

    const recentReviews = [...filteredProfile.reviews]
        .sort((a, b) => b.publishedAt - a.publishedAt)
        .slice(0, 20);

    const consensusRepo = new ConsensusRepository();
    const productIds = Array.from(
        new Set(recentReviews.map((r) => r.productId).filter(Boolean) as string[]),
    );
    const consensusEntries = await Promise.all(
        productIds.map(
            async (pid) =>
                [pid, (await consensusRepo.get(filteredProfile.store.storeUid, pid))?.text] as const,
        ),
    );
    const productConsensus: Record<string, string> = {};
    for (const [pid, text] of consensusEntries) if (text) productConsensus[pid] = text;

    // Deliberate divergence from getPublicReviews (which guards on lastRepliedAt):
    // the cert page reads replies for all ≤20 recentReviews unconditionally because
    // ReviewItem lacks lastRepliedAt (no cheap guard available) and the bounded read
    // count (≤20) combined with s-maxage caching keeps the cost acceptable.
    const replyEntries = await Promise.all(
        recentReviews.map(async (r): Promise<[string, Array<{ text: string }>]> => {
            if (!r.id) return ['', []];
            const snap = await dbAdmin().collection('reviews').doc(r.id).collection('replies')
                .where('visibility', '==', 'public').orderBy('createdAt', 'asc').get();
            return [r.id, snap.docs.map((d) => ({ text: String((d.data() as { text?: string }).text || '') }))];
        }),
    );
    const repliesByReview: Record<string, Array<{ text: string }>> = {};
    for (const [rid, reps] of replyEntries) if (rid && reps.length) repliesByReview[rid] = reps;

    const jsonLd = buildCertificateSchema({
        store: {
            storeUid: filteredProfile.store.storeUid,
            name: filteredProfile.store.name || "متجر",
            url: filteredProfile.store.domain
                ? (filteredProfile.store.domain.startsWith("http")
                    ? filteredProfile.store.domain
                    : `https://${filteredProfile.store.domain}`)
                : null,
        },
        stats: {
            avgRating: filteredProfile.stats.avgStars,
            reviewCount: filteredProfile.stats.totalReviews,
        },
        certificate: {
            number: certCode(filteredProfile.store.storeUid),
            lastUpdateISO: new Date(lastUpdateMs || Date.now()).toISOString(),
        },
        reviews: recentReviews.map((r) => ({
            authorName: r.author.displayName || "عميل المتجر",
            rating: r.stars,
            text: r.text || "",
            dateISO: new Date(r.publishedAt).toISOString(),
            // productId + productName drive the per-Product nodes the
            // schema builder emits. Reviews without a productId (some
            // legacy backfill rows) fall back to itemReviewed = store.
            productId: r.productId,
            productName: r.productName,
            replies: repliesByReview[r.id] || undefined,
        })),
        // Maps the store's platform identifier to the Arabic label embedded
        // in each review's natural-language verification annotation. Falls
        // back to "سلة / زد" (already the schema default) for any new platform
        // we add without remembering to extend this mapping.
        platformLabel:
            filteredProfile.store.platform === "salla" ? "سلة"
            : filteredProfile.store.platform === "zid" ? "زد"
            : undefined,
        productConsensus,
    });

    return {
        props: {
            ...props,
            profile: filteredProfile,
            jsonLd,
        },
    };
};

export default StoreReviewsPage;
