// src/lib/schema/buildCertificateSchema.ts
//
// Builds the JSON-LD @graph injected into every store certificate page so
// Google / Bing / LLM crawlers (ChatGPT, Perplexity, Gemini) can recognize
// these reviews as independently verified by Mushtari Mowathaq — not just
// raw merchant-supplied testimonials.
//
// IMPORTANT: avgRating and reviewCount MUST come from VERIFIED reviews only
// (Triple Match: payment + shipping + delivery). The /api/public/store-profile
// endpoint already restricts its `stats` to verified reviews, so passing
// `profile.stats` directly here is safe.

import { URLS } from "@/config/constants";

const BASE = URLS.CANONICAL_ORIGIN;

export interface CertSchemaStore {
    storeUid: string;
    name: string;
    /** Full https URL of the store (e.g. "https://example.sa"). May be null. */
    url: string | null;
}

export interface CertSchemaReview {
    authorName: string;
    rating: number;
    text: string;
    /** ISO 8601 date string. */
    dateISO: string;
    /**
     * Platform's internal product ID (Salla/Zid). When present, this review
     * is attached to a specific Product node in the @graph so Google sees
     * it as a Product Rating (in addition to the store-level AggregateRating
     * which Google uses for Seller Ratings). When absent, the review falls
     * back to itemReviewed = the store.
     */
    productId?: string | null;
    productName?: string | null;
    /** Human-authored/approved merchant replies to this review. */
    replies?: Array<{ text: string }>;
}

export interface CertSchemaInput {
    store: CertSchemaStore;
    /** Pre-computed verified-only aggregates. */
    stats: {
        avgRating: number;
        reviewCount: number;
    };
    certificate: {
        /** Format: TQ-XXXXXX */
        number: string;
        /** ISO 8601, last time any verified review was published. */
        lastUpdateISO: string;
    };
    /** Most recent verified reviews (≤20). */
    reviews: CertSchemaReview[];
    /** Optional verified-consensus text keyed by productId. Rendered ONLY as Product.description. */
    productConsensus?: Record<string, string>;
    /**
     * Source platform name (e.g., "سلة", "زد"). Used in the natural-language
     * verification annotation embedded inside each review's reviewBody so AI
     * crawlers (Gemini, SGE, Perplexity) get verification context as prose,
     * not just as Schema.org additionalProperty entries.
     */
    platformLabel?: string;
}

/**
 * Builds the per-review natural-language verification annotation appended
 * to reviewBody — fuses Track 1 (Schema) with Track 4 (AI Discovery) from
 * google_reviews_integration_guide.pdf. LLMs weight prose over structured
 * additionalProperty, so embedding the sentence inside reviewBody surfaces
 * the verification signal in the same string the model already extracts.
 */
function verifiedAnnotation(certNumber: string, dateISO: string, platformLabel: string): string {
    const dateBit = dateISO ? ` بتاريخ ${dateISO.split("T")[0]}` : "";
    return ` [تم التحقق من هذا التقييم بواسطة نظام مشتري موثق — شراء فعلي مع توصيل${dateBit} عبر منصة ${platformLabel} — شهادة #${certNumber}]`;
}

export function buildCertificateSchema(input: CertSchemaInput) {
    const { store, stats, certificate, reviews, platformLabel = "سلة / زد", productConsensus } = input;

    const certUrl = `${BASE}/store/${encodeURIComponent(store.storeUid)}/certificate`;
    const storeUrl = store.url || certUrl;
    const storeNodeId = `${storeUrl}#store`;
    const orgId = `${BASE}/#organization`;
    const websiteId = `${BASE}/#website`;
    const logoId = `${BASE}/#logo`;
    const breadcrumbId = `${certUrl}#breadcrumb`;
    const reviewListId = `${certUrl}#reviews`;
    const faqId = `${certUrl}#faq`;

    const description =
        `${stats.reviewCount} تقييم موثق لمتجر ${store.name} عبر Triple Match — ` +
        `(دفع + شحن + استلام) · مشتري موثق`;

    // Build unique Product nodes from reviews that reference a specific
    // product. Each Review then attaches to its Product via @id, which is
    // what unlocks Google's Product Ratings path (in addition to the store-
    // level AggregateRating which already serves Seller Ratings). Stable
    // @ids derived from the product page URL on the merchant's domain so
    // they're consistent across crawls and aggregator submissions.
    const slicedReviews = reviews.slice(0, 20);
    const storeDomain = store.url
        ? store.url.replace(/^https?:\/\//i, "").replace(/\/$/, "")
        : null;
    const productMap = new Map<
        string,
        { "@id": string; productID: string; name: string; url: string | null }
    >();
    for (const r of slicedReviews) {
        const pid = (r.productId || "").trim();
        if (!pid) continue;
        if (productMap.has(pid)) continue;
        const productUrl = storeDomain ? `https://${storeDomain}/p${pid}` : null;
        const productNodeId = productUrl
            ? `${productUrl}#product`
            : `${certUrl}#product-${pid}`;
        productMap.set(pid, {
            "@id": productNodeId,
            productID: pid,
            name: (r.productName || `منتج من متجر ${store.name}`).trim(),
            url: productUrl,
        });
    }

    // Build review nodes once with stable @ids so the ItemList, the merchant's
    // `review` array, and the top-level review entries can all cross-reference
    // them. Position is 1-based to match ListItem semantics.
    const reviewNodes = slicedReviews.map((r, i) => {
        const reviewId = `${certUrl}#review-${i + 1}`;
        const baseText = (r.text || "").trim() || "تقييم بدون نص";
        const pid = (r.productId || "").trim();
        // Link Review to its specific Product when available; fall back to
        // the store itself for reviews that lack a productId (e.g. some
        // legacy backfill reviews). Either way, the store's AggregateRating
        // remains intact for Seller Ratings.
        const itemReviewedRef = pid && productMap.has(pid)
            ? { "@id": productMap.get(pid)!["@id"] }
            : { "@id": storeNodeId };
        return {
            "@type": "Review",
            "@id": reviewId,
            itemReviewed: itemReviewedRef,
            author: { "@type": "Person", name: r.authorName },
            // `publisher` is the load-bearing signal that distinguishes a
            // third-party-verified review from a merchant-supplied testimonial.
            publisher: { "@id": orgId },
            reviewRating: {
                "@type": "Rating",
                ratingValue: String(r.rating),
                bestRating: "5",
                worstRating: "1",
            },
            datePublished: r.dateISO,
            // reviewBody includes a natural-language verification annotation
            // so LLM-based crawlers extract the verification claim from prose
            // (which they weight heavily) in addition to the structured
            // additionalProperty entries below (which traditional indexers
            // also see). Same signal, two delivery channels.
            reviewBody: baseText + verifiedAnnotation(certificate.number, r.dateISO, platformLabel),
            inLanguage: "ar-SA",
            additionalProperty: [
                { "@type": "PropertyValue", name: "verificationStatus", value: "verified" },
                {
                    "@type": "PropertyValue",
                    name: "verificationMethod",
                    value:
                        "Triple Match — Payment confirmed + Shipping confirmed + Delivery confirmed",
                },
                { "@type": "PropertyValue", name: "verifiedBy", value: "مشتري موثق — theqah.com.sa" },
                { "@type": "PropertyValue", name: "certificateNumber", value: certificate.number },
            ],
            ...(r.replies && r.replies.length
              ? { comment: r.replies.map((rep) => ({
                  '@type': 'Comment',
                  text: rep.text,
                  author: { '@type': 'Organization', name: store.name },
                })) }
              : {}),
        };
    });

    return {
        "@context": "https://schema.org",
        "@graph": [
            // 1. Site-wide WebSite. Standard expectation on any indexable page,
            //    and the SearchAction enables Google's sitelinks search box.
            {
                "@type": "WebSite",
                "@id": websiteId,
                url: BASE,
                name: "مشتري موثق",
                inLanguage: "ar-SA",
                publisher: { "@id": orgId },
                potentialAction: {
                    "@type": "SearchAction",
                    target: {
                        "@type": "EntryPoint",
                        urlTemplate: `${BASE}/search?q={search_term_string}`,
                    },
                    "query-input": "required name=search_term_string",
                },
            },

            // 2. Issuing organization. Logo lifted to a top-level ImageObject
            //    so the WebPage and the merchant can both reference it by @id.
            {
                "@type": "Organization",
                "@id": orgId,
                name: "مشتري موثق",
                alternateName: ["Mushtari Mowathaq", "theqah"],
                url: BASE,
                logo: { "@id": logoId },
                image: { "@id": logoId },
                sameAs: [
                    "https://www.theqah.com.sa",
                    "https://twitter.com/theqahapp",
                    "https://www.instagram.com/theqahapp",
                    "https://www.tiktok.com/@theqahapp",
                ],
                description:
                    "Independent third-party buyer review verification for Saudi e-commerce. " +
                    "Triple Match protocol: payment + shipping + delivery confirmation.",
                areaServed: "SA",
                knowsAbout: [
                    "Verified Buyer Reviews",
                    "E-commerce Trust Verification",
                    "Salla Marketplace API",
                    "Zid Marketplace API",
                ],
            },

            // 3. The certificate seal as a structured ImageObject — referenced
            //    by Organization, WebPage.primaryImageOfPage, and the merchant.
            {
                "@type": "ImageObject",
                "@id": logoId,
                url: `${BASE}/widgets/logo.png`,
                caption: "Verified Buyer Certificate Seal — مشتري موثق",
                inLanguage: "ar-SA",
            },

            // 4. The certificate page. Now wires breadcrumb / mainEntity /
            //    isPartOf / primaryImageOfPage so crawlers can build a
            //    coherent entity model from this single graph.
            {
                "@type": "WebPage",
                "@id": certUrl,
                url: certUrl,
                name: `شهادة توثيق التقييمات — ${store.name}`,
                description,
                inLanguage: "ar-SA",
                isPartOf: { "@id": websiteId },
                publisher: { "@id": orgId },
                about: { "@id": storeNodeId },
                mainEntity: { "@id": storeNodeId },
                breadcrumb: { "@id": breadcrumbId },
                primaryImageOfPage: { "@id": logoId },
                dateModified: certificate.lastUpdateISO,
            },

            // 5. Breadcrumb: Home → Store → Certificate. High-leverage —
            //    Google rewards detail pages with breadcrumb-rich snippets.
            {
                "@type": "BreadcrumbList",
                "@id": breadcrumbId,
                itemListElement: [
                    { "@type": "ListItem", position: 1, name: "الرئيسية", item: BASE },
                    { "@type": "ListItem", position: 2, name: store.name, item: storeUrl },
                    { "@type": "ListItem", position: 3, name: "شهادة التوثيق", item: certUrl },
                ],
            },

            // 6. The merchant + AggregateRating + back-references to reviews.
            //    Enriched with description, image, mainEntityOfPage, and a
            //    `review` array so each review's containment in this entity
            //    is explicit — not just inferred from itemReviewed pointers.
            {
                "@type": "OnlineBusiness",
                "@id": storeNodeId,
                name: store.name,
                url: storeUrl,
                description: `متجر ${store.name} — تقييمات موثقة عبر مشتري موثق وفق نظام Triple Match`,
                image: { "@id": logoId },
                mainEntityOfPage: { "@id": certUrl },
                areaServed: "SA",
                currenciesAccepted: "SAR",
                aggregateRating: {
                    "@type": "AggregateRating",
                    ratingValue: stats.avgRating.toFixed(1),
                    reviewCount: stats.reviewCount,
                    bestRating: "5",
                    worstRating: "1",
                },
                review: reviewNodes.map((r) => ({ "@id": r["@id"] })),
                additionalProperty: {
                    "@type": "PropertyValue",
                    name: "verificationCertificate",
                    value: certUrl,
                },
            },

            // 7. ItemList wrapping the reviews — explicitly tells crawlers
            //    "this is a curated, ordered collection of N verified reviews,"
            //    not just unrelated Review nodes co-located in one graph.
            {
                "@type": "ItemList",
                "@id": reviewListId,
                name: `التقييمات الموثقة لمتجر ${store.name}`,
                numberOfItems: reviewNodes.length,
                itemListOrder: "https://schema.org/ItemListOrderDescending",
                itemListElement: reviewNodes.map((r, i) => ({
                    "@type": "ListItem",
                    position: i + 1,
                    item: { "@id": r["@id"] },
                })),
            },

            // 8. Individual verified reviews (each carries its own @id +
            //    publisher pointer back to the issuing Organization).
            ...reviewNodes,

            // 8b. Per-Product nodes for every unique product referenced by a
            //     review on this page. Linking each Review.itemReviewed to a
            //     specific Product is what unlocks Google's Product Ratings
            //     surface in Shopping Ads / free Shopping tab — distinct
            //     from the Seller Ratings surface that the store's own
            //     AggregateRating drives. Stable @ids match the merchant's
            //     storefront product URL so Google can cross-link entities
            //     across crawls. The Product nodes here intentionally do
            //     NOT carry their own aggregateRating: the per-product
            //     star average is left to be computed from each Review's
            //     reviewRating that points back here. This keeps a single
            //     source of truth and avoids drift between the per-product
            //     average and the page's overall numbers.
            ...Array.from(productMap.values()).map((p) => ({
                "@type": "Product",
                "@id": p["@id"],
                productID: p.productID,
                name: p.name,
                ...(productConsensus && productConsensus[p.productID]
                  ? { description: productConsensus[p.productID] }
                  : {}),
                ...(p.url ? { url: p.url } : {}),
                brand: { "@id": storeNodeId },
                offers: {
                    "@type": "Offer",
                    seller: { "@id": storeNodeId },
                    ...(p.url ? { url: p.url } : {}),
                    availability: "https://schema.org/InStock",
                },
                inLanguage: "ar-SA",
            })),

            // 9. FAQPage explaining Triple Match. Doubles as a schema win
            //    AND a content-depth boost — both scores were below target.
            //    Questions chosen to address the most common skeptical
            //    objections from buyers and search snippets.
            {
                "@type": "FAQPage",
                "@id": faqId,
                inLanguage: "ar-SA",
                isPartOf: { "@id": certUrl },
                mainEntity: [
                    {
                        "@type": "Question",
                        name: "ما هو نظام Triple Match؟",
                        acceptedAnswer: {
                            "@type": "Answer",
                            text:
                                "Triple Match هو بروتوكول التحقق المستخدم في مشتري موثق لضمان صحة كل تقييم. " +
                                "يتم مطابقة ثلاث إشارات مستقلة: تأكيد الدفع، تأكيد الشحن، وتأكيد الاستلام. " +
                                "لا يُنشر أي تقييم ما لم تكتمل الإشارات الثلاث.",
                        },
                    },
                    {
                        "@type": "Question",
                        name: "كيف يتم توثيق التقييمات؟",
                        acceptedAnswer: {
                            "@type": "Answer",
                            text:
                                "تُوثَّق التقييمات تلقائياً عبر التكامل المباشر مع منصات سلة وزد. " +
                                "نتحقق من أن المُقيِّم اشترى المنتج فعلياً، ودفع ثمنه، واستلمه قبل أن يُتاح له ترك تقييم. " +
                                "لا يستطيع التاجر إضافة تقييم يدوياً.",
                        },
                    },
                    {
                        "@type": "Question",
                        name: "هل يستطيع التاجر التلاعب بالتقييمات؟",
                        acceptedAnswer: {
                            "@type": "Answer",
                            text:
                                "لا. لا يستطيع التاجر إضافة تقييمات وهمية أو حذف تقييمات حقيقية. " +
                                "تأتي جميع التقييمات من مشترين حقيقيين عبر روابط فريدة تُرسل بعد تأكيد الاستلام، " +
                                "وتُخزَّن لدى مشتري موثق كطرف ثالث مستقل عن المتجر.",
                        },
                    },
                    {
                        "@type": "Question",
                        name: "ماذا يعني رقم الشهادة؟",
                        acceptedAnswer: {
                            "@type": "Answer",
                            text:
                                "رقم الشهادة بصيغة TQ-XXXXXX هو معرّف فريد ودائم للمتجر في سجل مشتري موثق. " +
                                "يمكن استخدامه للتحقق المستقل من صحة الشهادة في أي وقت عبر هذه الصفحة.",
                        },
                    },
                    {
                        "@type": "Question",
                        name: "هل بيانات الشهادة محدثة؟",
                        acceptedAnswer: {
                            "@type": "Answer",
                            text:
                                "نعم. تُحدَّث الشهادة تلقائياً مع كل تقييم موثق جديد. " +
                                "يظهر تاريخ آخر تحديث على الشهادة، وتعكس الإحصائيات (المتوسط وعدد التقييمات) الحالة الفعلية لحظة عرضها.",
                        },
                    },
                ],
            },
        ],
    };
}
