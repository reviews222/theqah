//public/widgets/theqah-widget.js
(() => {
  const SCRIPT_VERSION = "4.4.0"; // V4.4.0: JSON-LD reviewBody embeds verification annotation for Gemini/SGE/AI Overviews + publisher.sameAs

  // ——— Verification annotation appended to reviewBody in JSON-LD ———
  //
  // Per google_reviews_integration_guide.pdf (Track 4 — AI Discovery), each
  // review's reviewBody field should carry a natural-language verification
  // sentence in addition to the structured-data metadata. LLM crawlers
  // (Gemini, SGE, Perplexity, Claude) weight prose over Schema additionalProperty
  // because additionalProperty is too generic — appending the sentence inside
  // the same string field they're already going to extract gets the signal
  // into the model's input with no extra parse step.
  function verifiedReviewBody(text, publishedAtMs) {
    const base = (text || '').trim();
    let dateSegment = '';
    if (publishedAtMs) {
      try {
        const d = new Date(publishedAtMs);
        if (!isNaN(d.getTime())) {
          // ISO YYYY-MM-DD — robots-friendly and unambiguous across locales.
          dateSegment = ` بتاريخ ${d.toISOString().split('T')[0]}`;
        }
      } catch { /* ignore */ }
    }
    const annotation = `[تم التحقق من هذا التقييم بواسطة نظام مشتري موثق — شراء فعلي مع توصيل${dateSegment} عبر منصة سلة]`;
    return base ? `${base} ${annotation}` : annotation;
  }

  // حماية من التشغيل المتعدد
  if (window.__THEQAH_LOADING__) return;
  window.__THEQAH_LOADING__ = true;

  // ——— تحديد السكربت والمصدر ———
  const CURRENT_SCRIPT = document.currentScript;
  const SCRIPT_ORIGIN = (() => {
    try {
      const origin = new URL(CURRENT_SCRIPT?.src || location.href).origin;
      // Always use www subdomain to avoid CORS redirect issues
      return origin.replace('://theqah.com.sa', '://www.theqah.com.sa');
    }
    catch { return location.origin; }
  })();

  const API_BASE = `${SCRIPT_ORIGIN}/api/public/reviews`;
  const CHECK_API = `${SCRIPT_ORIGIN}/api/reviews/check-verified`;
  const LOGO_URL = `${SCRIPT_ORIGIN}/widgets/logo.png?v=3`;
  const CERTIFICATE_LOGO_URL = `${SCRIPT_ORIGIN}/widgets/logo.png?v=3`;

  // ——— Helpers ———
  const h = (tag, attrs = {}, children = []) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else el.setAttribute(k, v);
    }
    (Array.isArray(children) ? children : [children])
      .filter(Boolean)
      .forEach((c) => (typeof c === "string" ? el.appendChild(document.createTextNode(c)) : el.appendChild(c)));
    return el;
  };

  // ——— Cache/Single-flight لنتيجة resolveStore ———
  const G = (window.__THEQAH__ = window.__THEQAH__ || {});
  const TTL_MS = 10 * 60 * 1000; // 10 دقائق

  function cacheKey(host) { return `theqah:storeUid:${host}`; }
  function getCached(host) {
    try {
      const o = JSON.parse(localStorage.getItem(cacheKey(host)) || '{}');
      if (o.uid && (Date.now() - (o.t || 0) < TTL_MS)) return o.uid;
    } catch { }
    return null;
  }
  function setCached(host, uid) {
    try { localStorage.setItem(cacheKey(host), JSON.stringify({ uid, t: Date.now() })); } catch { }
  }

  async function resolveStore() {
    const host = location.host.replace(/^www\./, '').toLowerCase();

    // ذاكرة + localStorage
    if (G.storeData) return G.storeData;
    const cached = getCached(host);
    if (cached) {
      // For backwards compatibility, handle both old format (string) and new format (object)
      if (typeof cached === 'string') {
        G.storeData = { storeUid: cached, certificatePosition: 'auto' };
      } else {
        G.storeData = cached;
      }
      return G.storeData;
    }

    // single-flight
    if (G.resolvePromise) return G.resolvePromise;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const url = `${API_BASE}/resolve?host=${encodeURIComponent(host)}&href=${encodeURIComponent(location.href)}&v=${encodeURIComponent(SCRIPT_VERSION)}`;
    G.resolvePromise = fetch(url, {
      cache: 'no-store',
      signal: controller.signal
    })
      .then(r => {
        clearTimeout(timeoutId);
        return r.ok ? r.json() : null;
      })
      .then(j => {
        if (!j?.storeUid) return null;
        const storeData = {
          storeUid: j.storeUid,
          certificatePosition: j.certificatePosition || 'auto'
        };
        G.storeData = storeData;
        setCached(host, storeData);
        return storeData;
      })
      .catch(() => {
        clearTimeout(timeoutId);
        return null;
      })
      .finally(() => { G.resolvePromise = null; });

    return G.resolvePromise;
  }

  // ——— إدراج الحاوية ———
  function findProductAnchor() {
    const fromData = document.querySelector("[data-product-id], [data-productid]");
    if (fromData) {
      const sec = fromData.closest("section, .product, .product-page, .product__details, .product-single, .product-show");
      if (sec) return sec;
    }

    const candidates = [
      ".product-description",
      ".product__description",
      "#product-description",
      ".product__details",
      ".product-show",
      ".product-single",
      ".product-details",
      ".product-info",
      ".product-main",
      "#product-show",
      "#product",
      "main .container"
    ];

    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }

    return null;
  }

  function ensureHostUnderProduct() {
    let host = document.querySelector("#theqah-reviews, .theqah-reviews");
    if (host) return host;

    const anchor = findProductAnchor();
    if (!anchor) return null;

    host = document.createElement("div");
    host.className = "theqah-reviews";
    host.style.marginTop = "24px";

    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(host, anchor.nextSibling);
    }

    return host;
  }

  // ——— Debounce ———
  function debounce(func, wait) {
    let timeoutId;
    return function (...args) {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => func.apply(this, args), wait);
    };
  }

  // ——— Extract product ID from page ———
  function extractProductId() {
    const fromData = document.querySelector("[data-product-id], [data-productid]");
    if (fromData) {
      const id = fromData.getAttribute("data-product-id") || fromData.getAttribute("data-productid");
      if (id) return id;
    }
    const match = location.pathname.match(/\/product\/(\d+)/);
    if (match) return match[1];
    const urlParams = new URLSearchParams(location.search);
    return urlParams.get('product_id') || urlParams.get('productId') || null;
  }

  function buildStoreReviewsUrl(storeUid, reviewId) {
    const base = `${SCRIPT_ORIGIN}/store/${encodeURIComponent(storeUid)}/reviews`;
    const params = new URLSearchParams();
    if (reviewId) params.set('review', reviewId);
    const query = params.toString();
    return query ? `${base}?${query}` : base;
  }

  // The certificate page enforces a 4+ star floor on the server. Never
  // build a `/reviews?minStars=4` URL for the certificate logo — that was
  // trivially bypassable by editing the query string.
  function buildStoreCertificateUrl(storeUid) {
    return `${SCRIPT_ORIGIN}/store/${encodeURIComponent(storeUid)}/certificate`;
  }

  // ——— Fetch store profile (name + verified count) ———
  async function fetchStoreProfile(storeUid) {
    try {
      // pageSize=20 — keep the per-page payload small but include enough
      // reviews to give AI crawlers a representative sample of the JSON-LD.
      const url = `${SCRIPT_ORIGIN}/api/public/store-profile?storeUid=${encodeURIComponent(storeUid)}&pageSize=20`;
      const res = await fetch(url, {
        cache: 'default',
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) return null;
      const data = await res.json();
      return {
        storeName: data?.store?.name || null,
        storeDomain: data?.store?.domain || null,
        verifiedCount: Number.isFinite(data?.stats?.totalReviews) ? data.stats.totalReviews : 0,
        avgStars: Number.isFinite(data?.stats?.avgStars) ? data.stats.avgStars : 0,
        // Mapped to the shape `injectStoreWideJsonLd` and the existing
        // product-scoped injection both consume.
        reviews: Array.isArray(data?.reviews) ? data.reviews.map(r => ({
          stars: Number(r?.stars) || 0,
          text: String(r?.text || ''),
          authorName: r?.author?.displayName || 'عميل',
          publishedAt: r?.publishedAt || null,
          productName: null,
        })).filter(r => r.stars > 0) : [],
      };
    } catch {
      return null;
    }
  }

  // ——— Store-wide JSON-LD injection (runs on every page load) ———
  //
  // The existing `injectReviewSchemaJsonLd` only fires on product pages
  // (it's gated behind `extractProductId()` + per-product API call).
  // Most stores have many *non*-product pages — home, categories,
  // about, contact — and AI crawlers visit those too. Without a
  // server-rendered Schema.org graph there, crawlers like Perplexity
  // and the lighter Google AI Overviews indexer never see the verified
  // reviews even though they exist in our DB.
  //
  // This injection runs once per page load, emitting a LocalBusiness
  // schema with aggregateRating + a sample of recent reviews. It uses
  // a separate DOM id (`theqah-store-jsonld`) so it doesn't collide
  // with the product-page graph — both can coexist on a product page.
  function injectStoreWideJsonLd(profile, storeUid) {
    if (!profile || !Array.isArray(profile.reviews) || profile.reviews.length === 0) return;
    if (document.getElementById('theqah-store-jsonld')) return; // already injected

    const validReviews = profile.reviews
      .filter(r => r && r.stars && r.authorName)
      .slice(0, 20);
    if (validReviews.length === 0) return;

    const certificateUrl = buildStoreCertificateUrl(storeUid);
    const businessName = profile.storeName || (profile.storeDomain ? profile.storeDomain : 'متجر');
    const businessUrl = profile.storeDomain
      ? (/^https?:\/\//i.test(profile.storeDomain) ? profile.storeDomain : `https://${profile.storeDomain}`)
      : location.origin;

    const reviewSchema = validReviews.map(r => {
      const review = {
        '@type': 'Review',
        'author': { '@type': 'Person', 'name': r.authorName },
        'reviewRating': {
          '@type': 'Rating',
          'ratingValue': r.stars,
          'bestRating': 5,
          'worstRating': 1,
        },
        'publisher': {
          '@type': 'Organization',
          'name': 'مشتري موثق - Theqah',
          'url': SCRIPT_ORIGIN,
          // sameAs is the canonical Schema.org property for "this entity is
          // also known by this external URL" — gives crawlers a stable anchor
          // back to the authoritative publisher even when SCRIPT_ORIGIN is
          // proxied through a CDN or alternate hostname.
          'sameAs': 'https://www.theqah.com.sa',
        },
        // Always emit reviewBody (even when r.text is empty) so the LLM-readable
        // verification annotation reaches the crawler. Empty source text still
        // yields a valid Schema.org Review — the annotation is enough signal.
        'reviewBody': verifiedReviewBody(r.text, r.publishedAt),
      };
      if (r.publishedAt) {
        try { review.datePublished = new Date(r.publishedAt).toISOString().split('T')[0]; }
        catch { /* ignore invalid date */ }
      }
      return review;
    });

    const total = profile.verifiedCount || validReviews.length;
    const avg = (profile.avgStars && profile.avgStars > 0)
      ? Number(profile.avgStars).toFixed(1)
      : (validReviews.reduce((s, r) => s + r.stars, 0) / validReviews.length).toFixed(1);

    const schema = {
      '@context': 'https://schema.org',
      '@type': 'LocalBusiness',
      'name': businessName,
      'url': businessUrl,
      'aggregateRating': {
        '@type': 'AggregateRating',
        'ratingValue': avg,
        'reviewCount': total,
        'bestRating': 5,
        'worstRating': 1,
      },
      'review': reviewSchema,
      // Cross-link to the public certificate so crawlers can verify
      // independently — same pattern theqah's own /certificate JSON-LD
      // uses to anchor authority for the reviews.
      'subjectOf': {
        '@type': 'WebPage',
        'url': certificateUrl,
        'name': 'شهادة التحقق من التقييمات - مشتري موثق',
      },
    };

    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id = 'theqah-store-jsonld';
    script.textContent = JSON.stringify(schema);
    document.head.appendChild(script);
  }

  // ——— Check verified reviews ———
  async function checkVerifiedReviews(storeId, productId) {
    try {
      const params = new URLSearchParams({ storeId });
      if (productId) params.append('productId', productId);
      const response = await fetch(`${CHECK_API}?${params}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) return { hasVerified: false, reviews: [] };
      return await response.json();
    } catch {
      return { hasVerified: false, reviews: [] };
    }
  }

  // ——— JSON-LD schema injection for AI search engines ———
  function injectReviewSchemaJsonLd(verifiedReviews, storeUid) {
    // Remove any previously injected Theqah JSON-LD to avoid duplicates
    const existing = document.getElementById('theqah-reviews-jsonld');
    if (existing) existing.remove();

    const validReviews = (Array.isArray(verifiedReviews) ? verifiedReviews : [])
      .filter(r => r && r.stars && r.authorName);
    if (validReviews.length === 0) return;

    // Extract product info from page JSON-LD if available
    let productName = null;
    let productUrl = null;
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        const data = JSON.parse(s.textContent);
        if (data['@type']?.toLowerCase() === 'product') {
          productName = data.name || null;
          productUrl = data.url || null;
          break;
        }
      }
    } catch { /* ignore */ }

    const reviewSchema = validReviews.map(r => {
      const review = {
        '@type': 'Review',
        'author': { '@type': 'Person', 'name': r.authorName },
        'reviewRating': {
          '@type': 'Rating',
          'ratingValue': r.stars,
          'bestRating': 5,
          'worstRating': 1
        },
        'publisher': {
          '@type': 'Organization',
          'name': 'مشتري موثق - Theqah',
          'url': SCRIPT_ORIGIN,
          'sameAs': 'https://www.theqah.com.sa'
        },
        // reviewBody always carries the natural-language verification
        // annotation — required for AI Discovery (Track 4 of the integration
        // guide). Even when the buyer left no text, the annotation alone is
        // a valid Schema.org Review body.
        'reviewBody': verifiedReviewBody(r.text, r.publishedAt)
      };
      if (r.publishedAt) review.datePublished = new Date(r.publishedAt).toISOString().split('T')[0];
      if (r.productName || productName) {
        review.itemReviewed = {
          '@type': 'Product',
          'name': r.productName || productName
        };
        if (productUrl) review.itemReviewed.url = productUrl;
      }
      return review;
    });

    // Calculate aggregate rating
    const totalStars = validReviews.reduce((sum, r) => sum + r.stars, 0);
    const avgRating = (totalStars / validReviews.length).toFixed(1);

    const schema = {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      'name': 'مشتري موثق - Theqah',
      'url': SCRIPT_ORIGIN,
      'review': reviewSchema
    };

    // If on a product page, also add AggregateRating
    if (productName || validReviews[0]?.productName) {
      schema['@type'] = 'Product';
      schema.name = productName || validReviews[0].productName;
      if (productUrl) schema.url = productUrl;
      schema.aggregateRating = {
        '@type': 'AggregateRating',
        'ratingValue': avgRating,
        'reviewCount': validReviews.length,
        'bestRating': 5,
        'worstRating': 1
      };
    }

    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.id = 'theqah-reviews-jsonld';
    script.textContent = JSON.stringify(schema);
    document.head.appendChild(script);
  }

  // ——— Render verified consensus paragraph ———
  async function renderConsensus(storeUid, productId) {
    try {
      if (!storeUid || !productId) return;
      // Avoid double-insertion on re-runs
      if (document.querySelector('.theqah-consensus')) return;

      const url = `${SCRIPT_ORIGIN}/api/public/consensus?storeUid=${encodeURIComponent(storeUid)}&productId=${encodeURIComponent(productId)}`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json();
      const c = data && data.consensus;
      if (!c || !c.text) return;

      const host = ensureHostUnderProduct();
      if (!host) return;
      if (host.querySelector('.theqah-consensus')) return;

      const box = document.createElement('div');
      box.className = 'theqah-consensus';
      box.setAttribute('dir', 'rtl');
      box.style.cssText = 'margin:12px 0;padding:12px 14px;border-radius:10px;'
        + 'background:#f6f9f6;border:1px solid #e2efe2;font-size:14px;line-height:1.7;color:#1f3d2b;';
      const label = document.createElement('div');
      label.style.cssText = 'font-weight:700;margin-bottom:4px;color:#137a3a;';
      label.textContent = 'خلاصة مشتري موثق';
      const body = document.createElement('p');
      body.style.cssText = 'margin:0;';
      body.textContent = c.text; // visible text only — set via textContent (never innerHTML), NOT injected as Review schema
      box.appendChild(label);
      box.appendChild(body);
      host.insertBefore(box, host.firstChild);
    } catch (e) {
      /* consensus is non-critical: never disrupt the widget */
    }
  }

  // ——— Fetch and add logos helper ———
  async function fetchAndAddLogos(storeUid) {
    try {
      const productId = extractProductId();
      const checkResult = await checkVerifiedReviews(storeUid, productId);

      if (checkResult.hasVerified) {
        // Inject JSON-LD schema for AI search engines (uses full review data)
        injectReviewSchemaJsonLd(checkResult.reviews, storeUid);

        const verifiedReviews = (Array.isArray(checkResult.reviews) ? checkResult.reviews : [])
          .filter(r => r && r.sallaReviewId)
          .map(r => ({
            reviewId: r.reviewId ? String(r.reviewId) : null,
            sallaReviewId: String(r.sallaReviewId),
            // Full data kept around so the owner-share button can build
            // a populated share-card URL without re-fetching.
            stars: Number(r.stars) || 0,
            text: r.text || '',
            authorName: r.authorName || r.author?.displayName || '',
            productName: r.productName || '',
          }));

        G.verifiedReviews = verifiedReviews;
        G.verifiedIds = verifiedReviews.map(r => r.sallaReviewId);
        addLogosToSallaReviews(verifiedReviews, storeUid);

        // iOS Safari: Shadow DOM / custom elements render late.
        // Retry logo injection with increasing delays to catch late-rendered reviews.
        const expectedCount = verifiedReviews.length;
        const retryDelays = [500, 1500, 3000, 5000];
        retryDelays.forEach(delay => {
          setTimeout(() => {
            const currentCount = document.querySelectorAll('.theqah-verified-logo').length;
            if (currentCount < expectedCount) {
              addLogosToSallaReviews(verifiedReviews, storeUid);
            }
          }, delay);
        });

        renderConsensus(storeUid, productId);
      }
    } catch { /* silent */ }
  }

  // ——— Owner-only share feature (V4.2) ———
  //
  // The share button appears beside each verified review *only* for the
  // store owner. Detection signal: a `?theqah_owner=1` URL query param
  // (sticky via sessionStorage so it persists across in-store navigation
  // without the merchant having to add the param to every page). Customers
  // never see the button.
  //
  // Clicking the share button opens a modal with five options: X / Facebook
  // / Instagram / TikTok / copy link. Each option uses share-card.tsx (a
  // server-side @vercel/og endpoint) to render the 1080×1080 PNG.
  // 30-minute sliding expiry on the owner-mode flag — if the merchant
  // hasn't refreshed/navigated in 30 min, their browser tab is treated
  // as a non-owner session so the share button stops appearing. Each
  // navigation resets the timer.
  const OWNER_TTL_MS = 30 * 60 * 1000;

  function isOwnerMode() {
    try {
      const qp = new URLSearchParams(location.search);
      if (qp.get('theqah_owner') === '1') {
        sessionStorage.setItem('theqah:owner', String(Date.now()));
        return true;
      }
      if (qp.get('theqah_owner') === '0') {
        sessionStorage.removeItem('theqah:owner');
        return false;
      }
      const stamp = sessionStorage.getItem('theqah:owner');
      if (!stamp) return false;
      const ts = Number(stamp);
      if (!Number.isFinite(ts) || Date.now() - ts > OWNER_TTL_MS) {
        sessionStorage.removeItem('theqah:owner');
        return false;
      }
      // Refresh the timer on each check so active sessions stay active.
      sessionStorage.setItem('theqah:owner', String(Date.now()));
      return true;
    } catch {
      return false;
    }
  }

  // Show a small floating banner so the merchant always knows they're in
  // owner-preview mode (and can click to exit). This makes it obvious
  // the share button is invisible to customers — addresses the common
  // worry "is the button showing up for everyone".
  function ensureOwnerModeBanner() {
    if (document.getElementById('theqah-owner-banner')) return;
    const banner = h('div', { id: 'theqah-owner-banner' });
    banner.style.cssText = [
      'position:fixed', 'bottom:16px', 'inset-inline-start:16px', 'z-index:2147483645',
      'background:#0a1020', 'color:#f0dcab', 'border:1.5px solid #8a6d3b',
      'padding:8px 14px', 'border-radius:999px',
      'font:800 12px/1 Cairo,system-ui,sans-serif', 'direction:rtl',
      'box-shadow:0 8px 22px -6px rgba(0,0,0,0.5)', 'cursor:pointer',
      'display:flex', 'align-items:center', 'gap:8px',
    ].join(';');
    banner.appendChild(document.createTextNode('وضع المعاينة - صاحب المتجر فقط · إغلاق ×'));
    banner.title = 'هذا الزر مخفي عن العملاء. اضغط لإيقاف وضع المعاينة في هذا المتصفح.';
    banner.addEventListener('click', () => {
      try { sessionStorage.removeItem('theqah:owner'); } catch { /* ignore */ }
      document.querySelectorAll('.theqah-owner-share-btn').forEach(b => b.remove());
      banner.remove();
    });
    document.body.appendChild(banner);
  }

  function extractPageProductImage() {
    try {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        try {
          const data = JSON.parse(s.textContent || '');
          const arr = Array.isArray(data) ? data : [data];
          for (const node of arr) {
            const t = node?.['@type'];
            const isProduct = t === 'Product' || (Array.isArray(t) && t.includes('Product'));
            if (isProduct && node?.image) {
              const img = Array.isArray(node.image) ? node.image[0] : node.image;
              if (typeof img === 'string') return img;
              if (img?.url) return img.url;
            }
          }
        } catch { /* ignore one invalid block */ }
      }
    } catch { /* ignore */ }
    try {
      const og = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
      if (og) return og;
    } catch { /* ignore */ }
    return '';
  }

  // The store's own logo (NOT the Theqah logo). Looked up at first share
  // and cached for the session. We try the standard Salla theme markers
  // first, then fall back to a generic header-logo selector. Used as
  // the hero brand image in the share card header.
  function extractPageStoreLogo() {
    if (G._pageStoreLogo) return G._pageStoreLogo;
    const candidates = [
      'header a[href="/"] img',
      'header .logo img',
      '[class*="store-logo"] img',
      'a[aria-label*="logo" i] img',
      'header img[alt*="logo" i]',
      'header img',
    ];
    for (const sel of candidates) {
      try {
        const img = document.querySelector(sel);
        const src = img?.currentSrc || img?.src;
        if (src && /^https?:/.test(src)) {
          G._pageStoreLogo = src;
          return src;
        }
      } catch { /* ignore */ }
    }
    return '';
  }

  function buildShareCardUrl(payload) {
    const params = new URLSearchParams();
    if (payload.store) params.set('store', payload.store);
    if (payload.storeLogo) params.set('storeLogo', payload.storeLogo);
    if (payload.storeUid) params.set('storeUid', payload.storeUid);
    if (payload.author) params.set('author', payload.author);
    if (payload.text) params.set('text', payload.text);
    if (payload.product) params.set('product', payload.product);
    if (payload.productImg) params.set('productImg', payload.productImg);
    if (payload.stars) params.set('stars', String(payload.stars));
    params.set('handle', '@theqahapp');
    // Cache-buster tied to widget version. When we ship a new layout
    // (e.g. moving stars or changing the footer), bumping SCRIPT_VERSION
    // changes the cache key so the edge serves a fresh render rather
    // than the stale PNG. Sub-URL stays stable per-version so crawler
    // caches (Facebook, X) still benefit from edge caching within a
    // release.
    params.set('v', SCRIPT_VERSION);
    return `${SCRIPT_ORIGIN}/api/og/share-card?${params.toString()}`;
  }

  // Build the share-post text. Format the merchant requested:
  //   ⭐⭐⭐⭐⭐ تقييم على {product or store}
  //
  //   "{review text}"
  //   — {author}
  //
  //   مدقق بواسطة @theqahapp
  //   {product URL on the live store}
  //
  // The product URL (location.href of the page the share happened on) is
  // appended as the last line so X/Facebook crawlers use IT as the
  // link-preview source — that surfaces the product on the merchant's
  // own Salla page instead of theqah.com.sa.
  function buildShareText(payload, urlForCaption) {
    const stars = '⭐'.repeat(Math.max(1, Math.min(5, payload.stars || 5)));
    const excerpt = (payload.text || '').length > 200
      ? (payload.text || '').slice(0, 197) + '…'
      : (payload.text || '');
    // Headline uses the PRODUCT name (latest merchant feedback: "i want
    // it to say the product name not the store"). Falls back to the
    // store name if product name isn't available.
    const headline = `${stars} تقييم موثق على ${payload.product || payload.store || 'متجرنا'}`;
    const lines = [
      headline,
      '',
      excerpt ? `"${excerpt}"` : '',
      payload.author ? `— ${payload.author}` : '',
      '',
      'مدقق بواسطة @theqahapp',
    ].filter(Boolean);
    if (urlForCaption) lines.push(urlForCaption);
    return lines.join('\n');
  }

  // Strip the owner-trigger param from a URL before sharing it
  // externally — `?theqah_owner=1` is for the merchant's own browser
  // session, not for public posts.
  function stripOwnerParam(url) {
    if (!url) return url;
    try {
      const u = new URL(url);
      u.searchParams.delete('theqah_owner');
      return u.toString();
    } catch {
      return url.replace(/[?&]theqah_owner=1\b/, '');
    }
  }

  // Open the share-card PNG in a new tab. We previously used a fetch +
  // blob + <a download> pattern, but that's a cross-origin fetch (the
  // widget runs on a Salla store domain, the share-card lives on
  // theqah.com.sa) and the endpoint doesn't return CORS headers — so
  // the fetch always failed with the merchant seeing "couldn't download
  // the image". window.open is a navigation, not a fetch, so no CORS
  // check applies. The merchant saves the image from the new tab.
  function openShareCardInNewTab(payload) {
    const cardUrl = buildShareCardUrl(payload);
    window.open(cardUrl, '_blank', 'noopener');
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }

  // Inline SVG icons returned as strings — fed to h() via the `html`
  // attr key, the same pattern the rest of this widget uses for icons.
  const SVG_X = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2H21l-6.52 7.45L22 22h-6.84l-4.74-6.18L4.8 22H2.04l6.98-7.97L2 2h6.96l4.28 5.66L18.244 2Zm-2.4 18.2h1.86L7.27 3.7H5.32l10.52 16.5Z"/></svg>';
  const SVG_FB = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 12a10 10 0 1 0-11.56 9.88v-6.99H7.9V12h2.54V9.8c0-2.51 1.5-3.9 3.78-3.9 1.1 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.77l-.44 2.9h-2.33v6.98A10 10 0 0 0 22 12Z"/></svg>';
  const SVG_IG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c2.72 0 3.06.01 4.12.06 1.07.05 1.79.22 2.43.46.66.26 1.22.6 1.77 1.16.56.55.9 1.11 1.16 1.77.25.64.42 1.37.46 2.43.05 1.07.06 1.4.06 4.12s-.01 3.06-.06 4.12c-.05 1.07-.22 1.79-.46 2.43-.26.66-.6 1.22-1.16 1.77-.55.56-1.11.9-1.77 1.16-.64.25-1.37.42-2.43.46-1.07.05-1.4.06-4.12.06s-3.06-.01-4.12-.06c-1.07-.05-1.79-.22-2.43-.46a4.92 4.92 0 0 1-1.77-1.16 4.92 4.92 0 0 1-1.16-1.77c-.25-.64-.42-1.37-.46-2.43C2.01 15.06 2 14.72 2 12s.01-3.06.06-4.12c.05-1.07.22-1.79.46-2.43.26-.66.6-1.22 1.16-1.77.55-.56 1.11-.9 1.77-1.16.64-.25 1.37-.42 2.43-.46C8.94 2.01 9.28 2 12 2Zm0 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 1.8a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4Zm5.25-3.05a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z"/></svg>';
  const SVG_TT = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.3 7.6a6.66 6.66 0 0 1-3.94-1.27V15.4a5.6 5.6 0 1 1-5.6-5.6c.18 0 .36.01.54.03v2.4a3.2 3.2 0 1 0 2.66 3.16V2h2.4a4.66 4.66 0 0 0 3.94 4.6v2.4-1.4Z"/></svg>';
  const SVG_COPY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z"/></svg>';
  const SVG_SHARE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';

  function makePlatformButton(platform, label, desc, iconClass, svgHtml) {
    const ico = h('span', { class: 'ico ' + iconClass, html: svgHtml });
    const info = h('span', { style: 'flex:1;' }, [
      h('b', {}, label),
      h('span', {}, desc),
    ]);
    const btn = h('button', { class: 'theqah-share-pbtn', 'data-platform': platform, type: 'button' }, [ico, info]);
    return btn;
  }

  let shareModalInjected = false;
  function ensureShareModal() {
    if (shareModalInjected) return;
    shareModalInjected = true;
    const style = h('style', {
      id: 'theqah-share-modal-style',
      html: `
        .theqah-share-back { position:fixed; inset:0; background:rgba(15,23,42,0.55); z-index:2147483646; display:none; align-items:center; justify-content:center; padding:20px; backdrop-filter:blur(3px); font-family:'Cairo',system-ui,sans-serif; direction:rtl; }
        .theqah-share-back.open { display:flex; }
        .theqah-share-modal { background:white; border-radius:18px; max-width:460px; width:100%; max-height:90vh; overflow-y:auto; box-shadow:0 20px 60px -10px rgba(15,23,42,0.4); color:#0f172a; }
        .theqah-share-h { padding:18px 22px; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center; }
        .theqah-share-h h3 { margin:0; font-size:16px; font-weight:900; }
        .theqah-share-close { background:none; border:none; cursor:pointer; font-size:24px; color:#64748b; line-height:1; padding:4px 8px; }
        .theqah-share-b { padding:18px 22px; }
        .theqah-share-intro { font-size:12px; color:#64748b; margin:0 0 14px; line-height:1.7; }
        .theqah-share-pbtn { width:100%; display:flex; align-items:center; gap:12px; padding:12px 14px; border-radius:12px; border:1px solid #e2e8f0; background:white; margin-bottom:8px; cursor:pointer; font-family:inherit; text-align:start; transition:all 0.15s ease; color:#0f172a; }
        .theqah-share-pbtn:hover { border-color:#2a3860; background:#fafbff; }
        .theqah-share-pbtn .ico { width:36px; height:36px; border-radius:10px; display:flex; align-items:center; justify-content:center; color:white; flex-shrink:0; }
        .theqah-share-pbtn .ico svg { width:18px; height:18px; }
        .ico-x { background:#000; }
        .ico-fb { background:#1877f2; }
        .ico-ig { background:linear-gradient(135deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888); }
        .ico-tt { background:linear-gradient(135deg,#25f4ee,#000,#fe2c55); }
        .ico-copy { background:#2a3860; }
        .theqah-share-pbtn b { font-size:14px; font-weight:800; margin:0 0 2px; display:block; }
        .theqah-share-pbtn > span > span { font-size:11.5px; color:#64748b; line-height:1.5; display:block; }
        .theqah-share-toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); background:#0f172a; color:white; padding:12px 20px; border-radius:10px; font-size:13px; font-weight:700; z-index:2147483647; opacity:0; transition:opacity 0.2s ease; font-family:'Cairo',system-ui,sans-serif; }
        .theqah-share-toast.show { opacity:1; }
        .theqah-owner-share-btn { display:inline-flex !important; flex-direction:row !important; align-items:center !important; justify-content:center !important; gap:5px !important; background:white !important; border:1.5px solid #b89968 !important; color:#8a6d3b !important; padding:5px 10px !important; border-radius:999px !important; font-size:11px !important; font-weight:800 !important; cursor:pointer !important; font-family:'Cairo',system-ui,sans-serif !important; margin-inline-start:6px !important; flex-shrink:0 !important; transition:transform 0.15s ease, box-shadow 0.15s ease !important; box-shadow:0 2px 6px -2px rgba(184,153,104,0.4) !important; line-height:1 !important; height:auto !important; width:auto !important; min-width:0 !important; max-width:none !important; white-space:nowrap !important; vertical-align:middle !important; text-decoration:none !important; }
        .theqah-owner-share-btn:hover { transform:translateY(-1px) !important; box-shadow:0 4px 10px -2px rgba(184,153,104,0.6) !important; }
        .theqah-owner-share-btn svg { width:12px !important; height:12px !important; min-width:12px !important; max-width:12px !important; min-height:12px !important; max-height:12px !important; flex-shrink:0 !important; display:inline-block !important; vertical-align:middle !important; }
        .theqah-owner-share-btn > span { display:inline !important; white-space:nowrap !important; font-size:11px !important; line-height:1 !important; }
      `,
    });
    document.head.appendChild(style);

    const reviewerSpan = h('span', { id: 'theqah-share-reviewer', style: 'font-weight:700;color:#64748b;' });
    const heading = h('h3', {}, ['مشاركة تقييم ', reviewerSpan]);
    const closeBtn = h('button', { class: 'theqah-share-close', id: 'theqah-share-close', 'aria-label': 'إغلاق' }, '×');
    const headerBar = h('div', { class: 'theqah-share-h' }, [heading, closeBtn]);

    const intro = h('p', { class: 'theqah-share-intro' }, [
      'اختر المنصة. سيتم فتح نافذة جاهزة بالنص والصورة وذكر ',
      h('b', {}, '@theqahapp'),
      '.',
    ]);

    const buttons = [
      makePlatformButton('x', 'X (تويتر)', 'تغريدة جاهزة + رابط + صورة معاينة', 'ico-x', SVG_X),
      makePlatformButton('ig', 'Instagram', 'صورة 1080×1080 تنزيل + نص للنسخ', 'ico-ig', SVG_IG),
      makePlatformButton('tt', 'TikTok', 'نفس الصورة + نص جاهز للنسخ', 'ico-tt', SVG_TT),
      makePlatformButton('copy', 'نسخ الرابط فقط', 'للصق في WhatsApp، Snapchat، أو أي مكان', 'ico-copy', SVG_COPY),
    ];

    const body = h('div', { class: 'theqah-share-b' }, [intro, ...buttons]);
    const modal = h('div', { class: 'theqah-share-modal', role: 'dialog', 'aria-label': 'مشاركة التقييم' }, [headerBar, body]);
    const back = h('div', { class: 'theqah-share-back', id: 'theqah-share-back' }, [modal]);
    document.body.appendChild(back);

    const close = () => back.classList.remove('open');
    closeBtn.addEventListener('click', close);
    back.addEventListener('click', (e) => { if (e.target === back) close(); });

    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const platform = btn.getAttribute('data-platform');
        const payload = G._shareCurrent || {};
        const reviewUrl = payload.reviewUrl || SCRIPT_ORIGIN;

        // X/Facebook posts use the merchant's actual PRODUCT URL (the
        // page the share happened on) — that's what generates the
        // link-preview card. The text contains review excerpt + author
        // + @theqahapp mention.
        const productUrl = payload.productUrl || reviewUrl;
        if (platform === 'x') {
          // buildShareText already appends productUrl as the last line,
          // so X parses it as the tweet's link → renders preview card
          // from the Salla product page.
          const text = buildShareText(payload, productUrl);
          const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
          window.open(intent, '_blank', 'noopener');
        } else if (platform === 'ig' || platform === 'tt') {
          const caption = buildShareText(payload, 'theqah.com.sa');
          // On mobile devices with the Web Share API, open the system
          // share sheet — that sheet usually includes Instagram and
          // TikTok as targets and auto-fills the image + caption. This
          // is the closest thing to "auto-post" possible on those
          // platforms (neither has an open web-share URL like X does).
          // Desktop falls back to: download + clipboard caption.
          const cardUrl = buildShareCardUrl(payload);
          const platformLabel = platform === 'ig' ? 'Instagram' : 'TikTok';
          const tryWebShare = async () => {
            if (!navigator.share) return false;
            try {
              // Attempt to fetch the image as a File so the share sheet
              // can attach it directly (only works if CORS allows; on
              // theqah.com.sa origin it will, so the merchant can
              // attach the image to the IG/TT post natively).
              const res = await fetch(cardUrl);
              if (res.ok && navigator.canShare) {
                const blob = await res.blob();
                const file = new File([blob], `theqah-${payload.reviewId || 'review'}.png`, { type: 'image/png' });
                if (navigator.canShare({ files: [file] })) {
                  await navigator.share({ files: [file], text: caption, title: 'تقييم موثق' });
                  return true;
                }
              }
              await navigator.share({ text: caption, url: cardUrl, title: 'تقييم موثق' });
              return true;
            } catch {
              return false;
            }
          };
          tryWebShare().then((shared) => {
            if (shared) {
              showToast(`تم فتح خيارات المشاركة — اختر ${platformLabel}`);
            } else {
              // Desktop fallback: copy caption + open image in new tab
              copyToClipboard(caption);
              openShareCardInNewTab(payload);
              showToast(`الصورة فُتحت في تبويب جديد · النص منسوخ — احفظ الصورة وارفعها على ${platformLabel}`);
            }
          });
        } else if (platform === 'copy') {
          copyToClipboard(reviewUrl).then((ok) => {
            showToast(ok ? 'تم نسخ الرابط ✓' : 'تعذّر نسخ الرابط.');
          });
        }
        close();
      });
    });
  }

  function showToast(msg) {
    let t = document.querySelector('.theqah-share-toast');
    if (!t) {
      t = h('div', { class: 'theqah-share-toast' });
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3500);
  }

  function openShareModalFor(payload) {
    ensureShareModal();
    G._shareCurrent = payload;
    const back = document.getElementById('theqah-share-back');
    if (!back) return;
    const reviewerEl = back.querySelector('#theqah-share-reviewer');
    if (reviewerEl) reviewerEl.textContent = payload.author ? `— ${payload.author}` : '';
    back.classList.add('open');
  }

  function createShareButtonElement(payload) {
    const btn = h('button', {
      class: 'theqah-owner-share-btn',
      type: 'button',
      'aria-label': 'مشاركة هذا التقييم',
      title: 'شارك هذا التقييم الموثق',
      html: SVG_SHARE + '<span>مشاركة</span>',
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openShareModalFor(payload);
    });
    return btn;
  }

  // ——— Add logos to Salla reviews ———
  function addLogosToSallaReviews(verifiedReviews, storeUidOverride) {
    if (!Array.isArray(verifiedReviews) || verifiedReviews.length === 0) return;

    const reviewLinkMap = new Map();
    verifiedReviews.forEach((item) => {
      if (item?.sallaReviewId) {
        reviewLinkMap.set(String(item.sallaReviewId), item.reviewId ? String(item.reviewId) : null);
      }
    });

    // Convert verified IDs to strings for comparison
    const verifiedIdStrings = Array.from(reviewLinkMap.keys());


    // Salla modern theme uses salla-comment-item custom elements
    // with internal divs having id="s-comments-item-[REVIEW_ID]"
    const selectors = [
      'salla-comment-item',           // Salla modern custom element
      '.s-comments-item',              // Salla class selector
      '[id^="s-comments-item-"]',      // Direct ID pattern match
      '[data-review-id]',              // Legacy data attribute
      '[data-comment-id]',             // Alternative data attribute
      '.product-review',               // Generic
      '.review-item',                  // Generic
      '.s-review-item',                // Salla legacy
      '.comment-item',                 // Comment item
      '[class*="comment"]',            // Any class containing comment
      '[class*="review"]'              // Any class containing review
    ];

    let foundCount = 0;
    let addedCount = 0;

    selectors.forEach(selector => {
      const reviewElements = document.querySelectorAll(selector);

      reviewElements.forEach(el => {
        // Extract review ID from multiple possible sources
        let domReviewId = null;

        // 1. From data-review-id or data-comment-id attribute on the element itself
        domReviewId = el.getAttribute('data-review-id') || el.getAttribute('data-id') || el.getAttribute('data-comment-id');

        // 1b. Salla custom element attributes (Vue-style bindings rendered as attributes)
        if (!domReviewId) {
          domReviewId = el.getAttribute('comment-id') || el.getAttribute('commentid') ||
            el.getAttribute(':comment-id') || el.getAttribute(':id') ||
            el.getAttribute('review-id') || el.getAttribute('reviewid');
        }

        // 1c. For salla-comment-item, try to extract from any attribute containing a numeric ID
        if (!domReviewId && el.tagName?.toLowerCase() === 'salla-comment-item') {
          const attrs = el.attributes;
          for (let i = 0; i < attrs.length; i++) {
            const name = attrs[i].name.toLowerCase();
            if (name === 'class' || name === 'style' || name === 'slot') continue;
            const match = attrs[i].value.match(/^(\d{5,})$/); // Exact numeric ID
            if (match) {
              domReviewId = match[1];
              break;
            }
          }
        }

        // 2. From internal div with id="s-comments-item-[ID]"
        if (!domReviewId) {
          const wrapperDiv = el.querySelector('[id^="s-comments-item-"]');
          if (wrapperDiv) {
            const idMatch = wrapperDiv.id.match(/s-comments-item-(\d+)/);
            if (idMatch) domReviewId = idMatch[1];
          }
        }

        // 3. From element's own id if it matches the pattern
        if (!domReviewId && el.id) {
          const idMatch = el.id.match(/s-comments-item-(\d+)/) || el.id.match(/comment-(\d+)/) || el.id.match(/review-(\d+)/);
          if (idMatch) domReviewId = idMatch[1];
        }

        // 4. From nested element with data-review-id
        if (!domReviewId) {
          domReviewId = el.querySelector('[data-review-id]')?.getAttribute('data-review-id') ||
            el.querySelector('[data-comment-id]')?.getAttribute('data-comment-id');
        }

        // 5. Try to find ID in any attribute
        if (!domReviewId) {
          const attrs = el.attributes;
          for (let i = 0; i < attrs.length; i++) {
            const match = attrs[i].value.match(/(\d{5,})/); // Look for numeric IDs with 5+ digits
            if (match) {
              domReviewId = match[1];
              break;
            }
          }
        }

        // 6. Check shadow DOM for salla-comment-item (open shadow DOM only)
        if (!domReviewId && el.shadowRoot) {
          const shadowDiv = el.shadowRoot.querySelector('[id^="s-comments-item-"]');
          if (shadowDiv) {
            const idMatch = shadowDiv.id.match(/s-comments-item-(\d+)/);
            if (idMatch) domReviewId = idMatch[1];
          }
          // Also try other selectors inside shadow DOM
          if (!domReviewId) {
            const shadowReview = el.shadowRoot.querySelector('[data-review-id], [data-comment-id], [data-id]');
            if (shadowReview) {
              domReviewId = shadowReview.getAttribute('data-review-id') ||
                shadowReview.getAttribute('data-comment-id') ||
                shadowReview.getAttribute('data-id');
            }
          }
        }





        if (!domReviewId || !verifiedIdStrings.includes(String(domReviewId))) return;
        // Check for existing logo in both light DOM and shadow DOM
        if (el.querySelector('.theqah-verified-logo')) return;
        if (el.shadowRoot?.querySelector('.theqah-verified-logo')) return;

        // Two-tier insertion strategy:
        //  (1) preferred: place the logo as an immediate sibling of the
        //      reviewer's name heading, so it sits inline next to the name
        //      (the user-wrapper has flex-wrap:wrap on Salla themes and
        //      will spill the logo to a new row otherwise — see
        //      lodrbeautiful.com case).
        //  (2) fallback: any user-* / rating-* container, with the legacy
        //      appendChild behaviour.
        const nameEl =
          el.querySelector('.s-comments-item-user-info-name-with-margin') ||
          el.querySelector('.s-comments-item-user-info-name') ||
          el.querySelector('.s-comments-item-user-info h3') ||
          el.querySelector('h3');

        let insertPoint = null;
        let insertMode = 'append';

        if (nameEl) {
          insertPoint = nameEl;
          insertMode = 'afterend';
        } else {
          insertPoint =
            el.querySelector('.s-comments-item-user-wrapper') ||
            el.querySelector('[class*="user-name"]') ||
            el.querySelector('[class*="user-info"]') ||
            el.querySelector('[class*="author"]') ||
            el.querySelector('.review-header') ||
            el.querySelector('.review-stars') ||
            el.querySelector('.review-rating') ||
            el.querySelector('[class*="rating"]') ||
            el.firstElementChild;

          // Shadow DOM fallback for iOS Safari
          if (!insertPoint && el.shadowRoot) {
            insertPoint =
              el.shadowRoot.querySelector('.s-comments-item-user-info-name-with-margin') ||
              el.shadowRoot.querySelector('.s-comments-item-user-info-name') ||
              el.shadowRoot.querySelector('h3') ||
              el.shadowRoot.querySelector('.s-comments-item-user-wrapper') ||
              el.shadowRoot.querySelector('[class*="user-name"]') ||
              el.shadowRoot.querySelector('[class*="user-info"]') ||
              el.shadowRoot.querySelector('[class*="rating"]') ||
              el.shadowRoot.firstElementChild;
            if (insertPoint && (insertPoint.tagName?.toLowerCase() === 'h3')) {
              insertMode = 'afterend';
            }
          }
          if (!insertPoint) insertPoint = el;
        }

        const publicReviewId = reviewLinkMap.get(String(domReviewId));
        const resolvedStoreUid = storeUidOverride || G.storeData?.storeUid || G.storeUid || '';
        const logoLink = document.createElement('a');
        logoLink.href = resolvedStoreUid
          ? buildStoreReviewsUrl(resolvedStoreUid, publicReviewId)
          : SCRIPT_ORIGIN;
        logoLink.target = '_blank';
        logoLink.rel = 'noopener noreferrer';
        logoLink.title = publicReviewId
          ? 'مشتري موثق - عرض هذا التقييم الموثق'
          : 'مشتري موثق - عرض تقييمات المتجر';
        logoLink.style.cssText = 'display:inline-flex;align-items:center;text-decoration:none;transition:transform 0.2s ease;margin-inline-start:8px;flex-shrink:0;';
        logoLink.onmouseover = function () { this.style.transform = 'scale(1.1)'; };
        logoLink.onmouseout = function () { this.style.transform = 'scale(1)'; };

        // Inline placement next to the name: smaller logo so it doesn't
        // dwarf a ~24px-tall heading. Legacy fallback keeps the larger
        // logo used by older theme layouts.
        const inlineSize = insertMode === 'afterend' ? 28 : 60;
        const logo = document.createElement('img');
        logo.src = LOGO_URL;
        logo.className = 'theqah-verified-logo';
        logo.alt = 'مشتري موثق - Verified Buyer';
        logo.style.cssText = `width:${inlineSize}px;height:${inlineSize}px;margin:0 6px;display:inline-block;vertical-align:middle;cursor:pointer;background:transparent;`;

        logoLink.appendChild(logo);

        if (insertMode === 'afterend') {
          // Make the name's parent lay out in a row so the name + badge
          // sit on the same line. Most Salla themes wrap the h3 in a div
          // (.s-comments-item-user-info) that defaults to block.
          const parent = insertPoint.parentElement;
          if (parent) {
            parent.style.display = 'flex';
            parent.style.alignItems = 'center';
            parent.style.gap = '6px';
            parent.style.flexWrap = 'nowrap';
          }
          insertPoint.insertAdjacentElement('afterend', logoLink);
        } else {
          insertPoint.style.display = 'flex';
          insertPoint.style.alignItems = 'center';
          insertPoint.style.gap = '8px';
          insertPoint.appendChild(logoLink);
        }

        // Share button — injected as a sibling of the badge for EVERY
        // verified review, visible to all visitors (customers + owner).
        // Letting customers share verified reviews amplifies social
        // proof: verified buyers sharing in their own networks is more
        // credible than the merchant pushing it themselves.
        if (!el.querySelector('.theqah-owner-share-btn')) {
          const verifiedFull = (verifiedReviews || []).find(
            (v) => String(v.sallaReviewId) === String(domReviewId),
          ) || {};
          const sharePayload = {
            reviewId: publicReviewId || domReviewId,
            sallaReviewId: domReviewId,
            stars: verifiedFull.stars || 5,
            text: verifiedFull.text || '',
            author: verifiedFull.authorName || '',
            product: verifiedFull.productName || (document.querySelector('h1')?.textContent || '').trim(),
            productImg: G._pageProductImg || (G._pageProductImg = extractPageProductImage()),
            store: G.storeProfile?.storeName || '',
            storeLogo: extractPageStoreLogo(),
            storeUid: resolvedStoreUid,
            // URL of the actual Salla product page — what X/Facebook
            // crawl for the link preview card. We strip ?theqah_owner=1
            // so the owner-only trigger doesn't leak into public posts.
            productUrl: stripOwnerParam(location.href),
            // URL of the public per-review page on theqah.com.sa — kept
            // as a fallback for "Copy link" and as the IG/TT caption URL.
            reviewUrl: resolvedStoreUid ? buildStoreReviewsUrl(resolvedStoreUid, publicReviewId) : SCRIPT_ORIGIN,
          };
          const shareBtn = createShareButtonElement(sharePayload);
          logoLink.insertAdjacentElement('afterend', shareBtn);
        }
      });
    });
  }

  // ——— إنشاء بادج شهادة توثيق التقييمات ———
  function createCertificateBadge(lang = 'ar', theme = 'light', profile = null) {
    // Check if certificate already exists
    if (document.querySelector('.theqah-certificate-badge')) return null;

    // Inject Cairo Font if not present
    if (!document.getElementById('theqah-font-cairo')) {
      const link = document.createElement('link');
      link.id = 'theqah-font-cairo';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&display=swap';
      document.head.appendChild(link);
    }

    const isArabic = lang === 'ar';
    const isDark = theme === 'dark';

    const verifiedCount = Number.isFinite(profile?.verifiedCount) ? profile.verifiedCount : null;
    const storeName = (profile?.storeName || '').trim();
    const hasNoReviews = verifiedCount === 0;
    const hasReviews = Number.isFinite(verifiedCount) && verifiedCount > 0;

    const title = storeName
      ? storeName
      : (isArabic ? 'شهادة توثيق التقييمات' : 'Verified Reviews Certificate');

    let subtitle;
    if (hasNoReviews) {
      subtitle = isArabic
        ? `${storeName ? `متجر ${storeName}` : 'هذا المتجر'} انضم حديثاً لمنصة مشتري موثق وإلى الآن لا يوجد تقييمات موثقة`
        : `${storeName || 'This store'} recently joined Mushtari Mowthaq and has no verified reviews yet`;
    } else {
      subtitle = isArabic
        ? 'جميع تقييمات هذا المتجر مدققة من مشتري موثق "طرف ثالث" لضمان المصداقية'
        : 'All store reviews are audited by verified buyer "Third Party" to ensure credibility';
    }

    // Resolve the storeUid now — needed for both the certificate link and
    // the deterministic cert code (djb2 → base36 → 6 chars).
    const _certStoreUid = profile?._storeUid || G.storeData?.storeUid || G.storeUid || '';
    const certUrl = _certStoreUid ? buildStoreCertificateUrl(_certStoreUid) : SCRIPT_ORIGIN;

    const certCode = (uid) => {
      if (!uid) return '';
      let hash = 5381;
      for (let i = 0; i < uid.length; i++) {
        hash = ((hash * 33) ^ uid.charCodeAt(i)) >>> 0;
      }
      return 'TQ-' + (hash.toString(36).toUpperCase() + '000000').slice(0, 6);
    };
    const code = certCode(_certStoreUid);

    // Root container — transparent, vertical stack, centered.
    const container = h('div', {
      class: 'theqah-certificate-badge',
      style: `
        font-family: 'Cairo', system-ui, -apple-system, sans-serif;
        direction: ${isArabic ? 'rtl' : 'ltr'};
        text-align: center;
        background: transparent;
        border: none;
        padding: 28px 20px 24px;
        margin: 20px auto;
        max-width: 500px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 18px;
      `
    });

    // Logo — 140px, soft navy drop-shadow so it lifts off any background.
    const logoLink = h('a', {
      href: certUrl,
      target: '_blank',
      rel: 'noopener noreferrer',
      style: `display: inline-block; transition: transform 0.2s ease;`
    });
    const logo = h('img', {
      src: CERTIFICATE_LOGO_URL,
      alt: isArabic ? 'مشتري موثق' : 'Mushtari Mowthaq',
      style: `
        width: 140px;
        height: 140px;
        object-fit: contain;
        background: transparent;
        filter: drop-shadow(0 6px 20px rgba(30, 42, 74, 0.3));
      `
    });
    logoLink.appendChild(logo);
    logoLink.onmouseover = function () { this.style.transform = 'scale(1.05)'; };
    logoLink.onmouseout = function () { this.style.transform = 'scale(1)'; };
    container.appendChild(logoLink);

    // Title — champagne gold gradient; switch to brighter champagne on dark.
    const titleGradient = isDark
      ? 'linear-gradient(180deg, #f0dcab, #b89968)'
      : 'linear-gradient(180deg, #d9b879, #8a6d3b)';
    const titleEl = h('h3', {
      style: `
        font-size: 26px;
        font-weight: 900;
        margin: 0;
        line-height: 1.3;
        background: ${titleGradient};
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
        color: #8a6d3b;
        display: inline-block;
      `
    }, title);
    container.appendChild(titleEl);

    // Medallion — rounded navy rectangle with inline number + label, only
    // shown when the store actually has verified reviews. Gold ring + inner
    // rim lighting carry their own contrast regardless of host page colour.
    // Medallion temporarily hidden — set SHOW_MEDALLION = true to restore.
    const SHOW_MEDALLION = false;
    if (SHOW_MEDALLION && hasReviews) {
      const medallion = h('div', {
        style: `
          display: inline-flex;
          align-items: center;
          gap: 18px;
          padding: 16px 38px;
          border-radius: 16px;
          background: linear-gradient(160deg, #2a3860 0%, #17213f 50%, #0a1020 100%);
          box-shadow:
            inset 0 1px 0 rgba(232, 212, 160, 0.3),
            inset 0 -2px 6px rgba(0, 0, 0, 0.55),
            0 0 0 1.5px #b89968,
            0 12px 28px -10px rgba(10, 16, 32, 0.4);
        `
      });

      const numEl = h('div', {
        style: `
          font-family: 'Cairo', system-ui, sans-serif;
          font-size: 52px;
          font-weight: 900;
          line-height: 1;
          letter-spacing: -0.02em;
          background: linear-gradient(180deg, #fff8e1, #f0dcab 30%, #c9a86c 70%, #8a6d3b);
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          color: transparent;
          filter: drop-shadow(0 2px 0 rgba(10, 16, 32, 0.8));
        `
      }, String(verifiedCount));

      const lblEl = h('div', {
        style: `
          font-family: 'Cairo', system-ui, sans-serif;
          font-size: 14px;
          font-weight: 800;
          letter-spacing: 0.12em;
          background: linear-gradient(180deg, #f0dcab, #b89968);
          -webkit-background-clip: text;
          background-clip: text;
          -webkit-text-fill-color: transparent;
          color: transparent;
        `
      }, isArabic ? 'تقييم موثق' : (verifiedCount === 1 ? 'Verified Review' : 'Verified Reviews'));

      medallion.appendChild(numEl);
      medallion.appendChild(lblEl);
      container.appendChild(medallion);
    }

    // Subtitle — mid-slate on light, periwinkle on dark.
    const subtitleEl = h('p', {
      style: `
        font-size: 13.5px;
        font-weight: 600;
        color: ${isDark ? '#9fb0d0' : '#475569'};
        margin: 0;
        line-height: 1.75;
        max-width: 440px;
      `
    }, subtitle);
    container.appendChild(subtitleEl);

    // Cert-number chip — gold-outlined capsule, reads as an official seal.
    if (code) {
      const certBorder = isDark ? 'rgba(184, 153, 104, 0.5)' : 'rgba(184, 153, 104, 0.55)';
      const certColor = isDark ? '#c9a86c' : '#8a6d3b';
      const certChip = h('div', {
        style: `
          margin: 4px 0 0;
          padding: 7px 18px;
          border-radius: 999px;
          border: 1px solid ${certBorder};
          color: ${certColor};
          font-family: 'Cairo', system-ui, sans-serif;
          font-size: 10.5px;
          font-weight: 700;
          letter-spacing: 0.22em;
          display: inline-flex;
          align-items: center;
          gap: 8px;
        `
      });
      certChip.appendChild(document.createTextNode(isArabic ? 'رقم الشهادة · ' : 'CERTIFICATE · '));
      const codeEl = h('span', {
        style: `
          font-family: 'Courier New', ui-monospace, monospace;
          font-weight: 700;
          letter-spacing: 0.08em;
          color: inherit;
        `
      }, code);
      certChip.appendChild(codeEl);
      container.appendChild(certChip);
    }

    return container;
  }

  // ——— إدراج شهادة التوثيق في صفحة المتجر ———
  function insertCertificateBadge(storeUid, lang, theme, position = 'auto', profile = null) {
    // Check if already inserted
    const existing = document.querySelector('.theqah-certificate-badge');
    if (existing) {
      // Fix for tabbed interfaces: If existing badge is hidden (e.g. in a hidden tab),
      // remove it so we can re-insert in the active location.
      if (existing.offsetParent === null) {
        existing.remove();
      } else {
        return; // Already exists and is visible
      }
    }

    const certificate = createCertificateBadge(lang, theme, profile);
    if (!certificate) return;

    // Smart Heuristics: find best placement based on position setting
    const placement = findBestPlacement(position);

    if (!placement) return;

    if (placement.type === 'floating') {
      // Floating badge in corner
      certificate.style.cssText += `
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 9999;
        max-width: 320px;
        animation: theqah-slide-in 0.3s ease-out;
      `;
      document.body.appendChild(certificate);

    } else if (placement.element) {
      if (placement.position === 'before') {
        placement.element.parentNode.insertBefore(certificate, placement.element);
      } else {
        placement.element.parentNode.insertBefore(certificate, placement.element.nextSibling);
      }

    }
  }

  // ——— Smart Heuristics: تحديد أفضل مكان للشهادة ———
  function findBestPlacement(position) {
    // إذا حدد صاحب المتجر مكان معين
    if (position === 'before-reviews') {
      const reviews = document.querySelector(
        'salla-products-comments, .s-comments-list, .product-reviews, #reviews, [data-reviews]'
      );
      if (reviews) return { element: reviews, position: 'before' };
    }

    if (position === 'after-reviews') {
      const reviews = document.querySelector(
        'salla-products-comments, .s-comments-list, .product-reviews, #reviews, [data-reviews]'
      );
      if (reviews) return { element: reviews, position: 'after' };
    }

    if (position === 'footer') {
      const footer = document.querySelector('footer, .s-footer, .store-footer');
      if (footer) return { element: footer, position: 'before' };
    }

    if (position === 'floating') {
      return { type: 'floating' };
    }

    // Auto mode: Smart Heuristics based on page structure
    // أولوية 1: قبل قسم التقييمات مباشرة
    const reviewsSection = document.querySelector(
      'salla-products-comments, .s-comments-list, .product-reviews, .reviews-section, #reviews, [data-reviews]'
    );

    if (reviewsSection && isVisible(reviewsSection)) {
      return { element: reviewsSection, position: 'before' };
    }

    // أولوية 2: بعد وصف المنتج
    const productDesc = document.querySelector(
      '.product-description, .product__description, .s-product-description, [data-product-description]'
    );

    if (productDesc && isVisible(productDesc)) {
      return { element: productDesc, position: 'after' };
    }

    // أولوية 3: بعد معلومات المنتج
    const productInfo = document.querySelector(
      '.product-info, .product__info, .s-product-info, .product-details'
    );

    if (productInfo && isVisible(productInfo)) {
      return { element: productInfo, position: 'after' };
    }

    // أولوية 4: في الفوتر
    const footer = document.querySelector('footer, .s-footer');
    if (footer) {
      return { element: footer, position: 'before' };
    }

    // Fallback: Floating badge

    return { type: 'floating' };
  }

  // Helper to check visibility
  function isVisible(el) {
    return !!(el && el.offsetParent !== null);
  }

  // ——— تركيب البادج الذكي ———
  async function mountOne(hostEl, store, lang, theme, certificatePosition = 'auto') {
    // Fetch store profile (name + verified count) — cached per storeUid for the session
    if (!G.storeProfile || G.storeProfile._storeUid !== store) {
      const profile = await fetchStoreProfile(store);
      if (profile) {
        G.storeProfile = { ...profile, _storeUid: store };
      } else {
        G.storeProfile = { storeName: null, verifiedCount: null, _storeUid: store };
      }
    }

    // Always insert/update the certificate badge for subscribed stores
    // This runs on every mount/update check to handle tab switching
    insertCertificateBadge(store, lang, theme, certificatePosition, G.storeProfile);

    // If already mounted, still try to add logos (reviews tab might have just become visible)
    if (hostEl.getAttribute("data-state") === "done") {
      // Re-try logo injection even if already mounted
      if (G.verifiedReviews && G.verifiedReviews.length > 0) {
        addLogosToSallaReviews(G.verifiedReviews, G.storeUid);
      } else if (G.storeUid) {
        // If no verifiedIds cached yet, fetch them now
        fetchAndAddLogos(G.storeUid);
      }
      return;
    }
    if (hostEl.getAttribute("data-state") === "mounting") return;
    hostEl.setAttribute("data-state", "mounting");

    // Cache storeUid for later re-checks
    G.storeUid = store;

    // ✨ Check for verified reviews
    await fetchAndAddLogos(store);

    hostEl.setAttribute("data-state", "done");


    const style = h("style", {
      html: `
        :host { all: initial; }
        * { box-sizing: border-box; }
        
        .wrap { 
          font-family: system-ui,-apple-system,Segoe UI,Roboto,Helvetica Neue,Noto Sans,Liberation Sans,Arial,sans-serif; 
          direction: ${lang === "ar" ? "rtl" : "ltr"}; 
          line-height: 1.5;
          color: ${theme === "dark" ? "#f1f5f9" : "#1e293b"};
        }
        
        .section { 
          background: ${theme === "dark"
          ? "linear-gradient(135deg, #0f1629 0%, #1e293b 100%)"
          : "linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)"};
          color: ${theme === "dark" ? "#f1f5f9" : "#1e293b"};
          border: 1px solid ${theme === "dark" ? "rgba(71, 85, 105, 0.3)" : "rgba(226, 232, 240, 0.8)"};
          border-radius: 16px; 
          padding: 20px 24px; 
          margin: 20px 0; 
          box-shadow: ${theme === "dark"
          ? "0 10px 25px -5px rgba(0, 0, 0, 0.4)"
          : "0 10px 25px -5px rgba(0, 0, 0, 0.1)"};
          backdrop-filter: blur(12px);
          position: relative;
          overflow: hidden;
        }
        
        .section::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 1px;
          background: linear-gradient(90deg, 
            transparent 0%, 
            ${theme === "dark" ? "rgba(148, 163, 184, 0.3)" : "rgba(59, 130, 246, 0.3)"} 50%, 
            transparent 100%);
        }
        
        .verified-badge {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 0;
        }
        
        .badge-logo { 
          width: 48px; 
          height: 48px; 
          border-radius: 8px;
          flex-shrink: 0;
          transition: all 0.25s ease;
        }
        
        .badge-logo:hover { 
          transform: scale(1.05); 
        }
        
        .badge-text {
          font-size: 16px;
          font-weight: 600;
          color: ${theme === "dark" ? "#cbd5e1" : "#475569"};
          margin: 0;
          line-height: 1.5;
          letter-spacing: -0.01em;
        }
        
        @media (max-width: 640px) {
          .section { padding: 16px 20px; }
          .badge-text { font-size: 14px; }
          .badge-logo { width: 40px; height: 40px; }
        }
      `,
    });

    const verifiedText = lang === "ar"
      ? "تقييمات هذا المتجر تخضع للتدقيق بواسطة مشتري موثق"
      : "This store's reviews are verified by Theqah Trusted Buyer";

    const container = h("div", { class: "wrap" });

    const section = h("div", { class: "section" }, [
      h("div", { class: "verified-badge" }, [
        h("img", { class: "badge-logo", src: LOGO_URL, alt: "Theqah" }),
        h("p", { class: "badge-text" }, verifiedText),
      ]),
    ]);

    container.appendChild(section);
    root.appendChild(style);
    root.appendChild(container);

    hostEl.setAttribute("data-state", "done");
  }

  // ——— الدالة الرئيسية ———
  const safeMount = async () => {
    const existingHost = document.querySelector("#theqah-reviews, .theqah-reviews");

    let store =
      existingHost?.getAttribute?.("data-store") ||
      existingHost?.dataset?.store ||
      CURRENT_SCRIPT?.dataset?.store ||
      "";

    const lang =
      existingHost?.getAttribute?.("data-lang") ||
      existingHost?.dataset?.lang ||
      CURRENT_SCRIPT?.dataset?.lang ||
      (document.documentElement.lang === "ar" ? "ar" : "en");

    const theme =
      existingHost?.getAttribute?.("data-theme") ||
      existingHost?.dataset?.theme ||
      CURRENT_SCRIPT?.dataset?.theme ||
      "light";

    // تنظيف placeholder - تجاهل أي store ID يحتوي على placeholder
    if (store && (store.includes('{') || /STORE_ID/i.test(store) || store === 'salla:' || !store.includes(':'))) {
      store = '';
    }

    // محاولة auto-resolve - دائماً نحاول resolve من domain
    let storeData = null;
    let certificatePosition = 'auto';

    if (!store) {
      try {
        const resolveTimeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Resolve timeout')), 5000)
        );
        storeData = await Promise.race([resolveStore(), resolveTimeout]);
        if (storeData) {
          store = storeData.storeUid;
          certificatePosition = storeData.certificatePosition || 'auto';

        }
      }
      catch {
        store = null;
      }
    }

    // Store-wide JSON-LD: inject on EVERY page (home, category, about,
    // product) the moment we know the storeUid — independent of whether
    // the certificate badge mounts. AI crawlers find verified reviews
    // even on non-product pages this way. Cached response, ≤5s timeout.
    if (store && !document.getElementById('theqah-store-jsonld')) {
      try {
        const profile = G.storeProfileFull?._storeUid === store
          ? G.storeProfileFull
          : await fetchStoreProfile(store);
        if (profile) {
          G.storeProfileFull = { ...profile, _storeUid: store };
          injectStoreWideJsonLd(profile, store);
        }
      } catch { /* never block widget mount on JSON-LD */ }
    }

    const host = existingHost || ensureHostUnderProduct();

    if (!host) {
      // Not a product page - widget skipped (JSON-LD already injected above)
      return;
    }

    if (!store) {
      // Silent fail - store not resolved
      return;
    }

    await mountOne(host, store, String(lang).toLowerCase(), String(theme).toLowerCase(), certificatePosition);
    mountedOnce = true;
  };

  // تشغيل آمن
  const safeLaunch = () => {
    try {
      safeMount().catch(() => { });
    } catch {
      // Silent fail
    } finally {
      window.__THEQAH_LOADING__ = false;
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", safeLaunch);
  } else {
    setTimeout(safeLaunch, 100);
  }

  // دعم SPA + detect Salla review list changes (sorting/pagination/tab switching)
  if (!window.__THEQAH_OBS__ && typeof MutationObserver !== 'undefined') {
    window.__THEQAH_OBS__ = true;

    const reAddLogos = debounce(() => {
      // Use globally cached verified IDs
      if (G.verifiedReviews && G.verifiedReviews.length > 0) {
        addLogosToSallaReviews(G.verifiedReviews, G.storeUid);
      } else if (G.storeUid) {
        // If no cached IDs, try fetching them (first time reviews became visible)
        fetchAndAddLogos(G.storeUid);
      }
    }, 300);

    const deb = debounce(() => safeMount(), 1000);

    const obs = new MutationObserver((mutations) => {
      let hasRelevantChanges = false;
      let hasSallaReviewChanges = false;

      for (const m of mutations) {
        // Check for theqah-reviews container
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) {
            if (n.classList?.contains('theqah-reviews') || n.querySelector?.('.theqah-reviews')) {
              hasRelevantChanges = true;
            }
            // Detect Salla review elements being added (after sort/pagination)
            if (
              n.tagName?.toLowerCase() === 'salla-comment-item' ||
              n.classList?.contains('s-comments-item') ||
              (typeof n.id === 'string' && n.id.startsWith('s-comments-item-')) ||
              n.querySelector?.('salla-comment-item') ||
              n.querySelector?.('[id^="s-comments-item-"]')
            ) {
              hasSallaReviewChanges = true;
            }
          }
        }

        // Also check if reviews container children changed (Salla may replace inner content)
        if (m.target?.tagName?.toLowerCase() === 'salla-products-comments' ||
          m.target?.classList?.contains('s-comments-list')) {
          hasSallaReviewChanges = true;
        }

        // Detect attribute changes that indicate tab switching (display, class, aria changes)
        if (m.type === 'attributes') {
          const target = m.target;
          if (target?.nodeType === 1) {
            const tagName = target.tagName?.toLowerCase();
            const classList = target.classList;
            // Check if a reviews-related element became visible
            if (
              tagName === 'salla-products-comments' ||
              classList?.contains('s-comments-list') ||
              classList?.contains('s-comments') ||
              target.querySelector?.('salla-comment-item') ||
              target.querySelector?.('[id^="s-comments-item-"]')
            ) {
              hasSallaReviewChanges = true;
            }
            // Detect tab panel visibility changes
            if (
              m.attributeName === 'class' ||
              m.attributeName === 'style' ||
              m.attributeName === 'hidden' ||
              m.attributeName === 'aria-hidden' ||
              m.attributeName === 'role'
            ) {
              // Check if this element or its children contain review elements
              if (target.querySelector?.('salla-comment-item, .s-comments-item, [id^="s-comments-item-"]')) {
                hasSallaReviewChanges = true;
              }
            }
          }
        }
      }

      if (hasRelevantChanges) deb();
      if (hasSallaReviewChanges) reAddLogos();
    });

    try {
      obs.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,  // Watch attribute changes for tab switches
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-selected'],
        characterData: false
      });

      // Keep observer active longer for dynamic pages
      setTimeout(() => {
        obs.disconnect();
        window.__THEQAH_OBS__ = false;
      }, 300000); // Extended to 5 minutes
    } catch {
      // Silent fail
    }

    // Also listen for Salla custom events
    try {
      document.addEventListener('salla::comments::loaded', () => reAddLogos());
      document.addEventListener('salla::comments::sorted', () => reAddLogos());
      document.addEventListener('salla::comments::paginated', () => reAddLogos());
    } catch {
      // Silent fail
    }

    // Listen for clicks on tab buttons (common in Salla themes)
    try {
      document.addEventListener('click', (e) => {
        const target = e.target?.closest?.('[role="tab"], .tab, .tabs__item, .nav-link, [data-tab], [data-toggle="tab"]');
        if (!target) return;
        const text = (target.textContent || '').trim();
        // Check if this is a reviews/ratings tab
        if (/تقييم|التقييمات|reviews?|ratings?|comments?/i.test(text) ||
          target.getAttribute('data-tab')?.includes('comment') ||
          target.getAttribute('data-tab')?.includes('review') ||
          target.getAttribute('href')?.includes('comment') ||
          target.getAttribute('href')?.includes('review')) {
          // Delay to let the tab content render
          setTimeout(() => reAddLogos(), 500);
          setTimeout(() => reAddLogos(), 1500);
        }
      }, true);
    } catch {
      // Silent fail
    }
  }
})();
