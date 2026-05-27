export function parseDiscogsReleaseUrl(value) {
  const source = String(value ?? "").trim();

  if (!source) {
    return null;
  }

  try {
    const url = new URL(source);

    if (!/(^|\.)discogs\.com$/i.test(url.hostname)) {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    const releaseIndex = parts.indexOf("release");
    const sellReleaseIndex = parts[0] === "sell" && parts[1] === "release" ? 1 : -1;
    const idSource = releaseIndex >= 0 ? parts[releaseIndex + 1] : parts[sellReleaseIndex + 1];
    const id = parseLeadingId(idSource);

    if (!id) {
      return null;
    }

    return {
      id,
      title: titleFromSlug(idSource) || `Discogs release ${id}`,
      url: `https://www.discogs.com/release/${id}`
    };
  } catch {
    return null;
  }
}

export function buildMarketplaceUrl(releaseId, page = 1, limit = 250) {
  const url = new URL(`https://www.discogs.com/sell/release/${releaseId}`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort", "price,asc");
  return url.toString();
}

export async function scanMarketplaceForReleases({
  releases,
  filters = {},
  pageLimit = 3,
  fetchPage,
  onProgress = () => {}
}) {
  const safePageLimit = clampNumber(pageLimit, 1, 20);
  const listingsByRelease = new Map();
  const warnings = [];

  for (const [releaseIndex, release] of releases.entries()) {
    const releaseListings = [];

    for (let page = 1; page <= safePageLimit; page += 1) {
      onProgress({
        release,
        releaseIndex,
        releaseCount: releases.length,
        page,
        totalPages: safePageLimit
      });

      const html = await fetchPage(buildMarketplaceUrl(release.id, page));
      const parsed = parseMarketplaceHtml(html, release);
      releaseListings.push(...parsed.listings.filter((listing) => listingPassesFilters(listing, filters)));

      if (!parsed.hasNextPage) {
        break;
      }
    }

    if (!releaseListings.length) {
      warnings.push(`No listings found for ${release.title}.`);
    }

    listingsByRelease.set(release.id, releaseListings);
  }

  return {
    sellers: rankSharedSellers(releases, listingsByRelease),
    listingsByRelease,
    warnings
  };
}

export function parseMarketplaceHtml(html, release) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const listingAnchors = [...doc.querySelectorAll('a[href*="/sell/item/"]')];
  const containers = uniqueNodes(listingAnchors.map(getListingContainer).filter(Boolean));
  const listings = containers
    .map((container) => parseListingContainer(container, release))
    .filter((listing) => listing.id && listing.seller.username);

  return {
    listings,
    hasNextPage: hasNextPage(doc)
  };
}

export function rankSharedSellers(releases, listingsByRelease) {
  const sellers = new Map();

  for (const release of releases) {
    const listings = listingsByRelease.get(release.id) ?? [];

    for (const listing of listings) {
      const key = listing.seller.username.toLowerCase();

      if (!sellers.has(key)) {
        sellers.set(key, {
          username: listing.seller.username,
          url: listing.seller.url,
          rating: listing.seller.rating ?? 0,
          listingsByRelease: new Map()
        });
      }

      const seller = sellers.get(key);
      const existing = seller.listingsByRelease.get(release.id);
      seller.rating = Math.max(seller.rating, listing.seller.rating ?? 0);

      if (!existing || listing.sortPrice < existing.sortPrice) {
        seller.listingsByRelease.set(release.id, listing);
      }
    }
  }

  return [...sellers.values()]
    .map((seller) => {
      const listings = releases
        .map((release) => seller.listingsByRelease.get(release.id))
        .filter(Boolean);
      const subtotal = listings.reduce((sum, listing) => sum + listing.sortPrice, 0);

      return {
        ...seller,
        listings,
        matchedCount: listings.length,
        missingCount: releases.length - listings.length,
        isComplete: listings.length === releases.length,
        subtotal
      };
    })
    .sort((a, b) => {
      if (a.isComplete !== b.isComplete) return a.isComplete ? -1 : 1;
      if (a.matchedCount !== b.matchedCount) return b.matchedCount - a.matchedCount;
      if (a.subtotal !== b.subtotal) return a.subtotal - b.subtotal;
      if (a.rating !== b.rating) return b.rating - a.rating;
      return a.username.localeCompare(b.username);
    });
}

export function listingPassesFilters(listing, filters = {}) {
  const maximumPrice = optionalNumber(filters.maximumPrice);
  const minimumRating = optionalNumber(filters.minimumRating);
  const shipsFrom = normalizeSearchText(filters.shipsFrom);

  if (Number.isFinite(maximumPrice) && listing.sortPrice > maximumPrice) {
    return false;
  }

  if (
    Number.isFinite(minimumRating) &&
    Number.isFinite(listing.seller.rating) &&
    listing.seller.rating < minimumRating
  ) {
    return false;
  }

  if (shipsFrom && !normalizeSearchText(listing.shipsFrom).includes(shipsFrom)) {
    return false;
  }

  return true;
}

export function formatMoney(value, currency = "") {
  if (!Number.isFinite(value)) {
    return "Price unavailable";
  }

  if (!currency) {
    return value.toFixed(2);
  }

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol"
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function parsePriceText(text) {
  const source = stripText(text);
  const match = source.match(/([$\u20ac\u00a3])\s*([0-9][0-9.,]*)|([0-9][0-9.,]*)\s*(USD|EUR|GBP|CAD|AUD|SEK|JPY)/i);

  if (!match) {
    return { value: Number.NaN, currency: "" };
  }

  const symbol = match[1] || "";
  const amount = match[2] || match[3] || "";
  const code = match[4] || "";
  const currency = code.toUpperCase() || currencyFromSymbol(symbol);
  const value = Number(amount.replace(/,/g, ""));

  return {
    value: Number.isFinite(value) ? value : Number.NaN,
    currency
  };
}

function parseListingContainer(container, release) {
  const text = stripText(container.textContent);
  const itemAnchor = container.querySelector('a[href*="/sell/item/"]');
  const sellerAnchor = findSellerAnchor(container);
  const price = parsePriceFromContainer(container);
  const seller = parseSeller(sellerAnchor, text);

  return {
    id: parseListingId(itemAnchor?.href ?? ""),
    releaseId: release.id,
    releaseTitle: release.title,
    condition: extractField(text, /Media Condition\s*:?\s*([^]*?)(Sleeve Condition|Ships From|Seller|$)/i) ||
      extractCondition(text) ||
      "Condition unavailable",
    sleeveCondition: extractField(text, /Sleeve Condition\s*:?\s*([^]*?)(Ships From|Seller|$)/i),
    shipsFrom: extractField(text, /Ships From\s*:?\s*([^]*?)(Seller|$)/i),
    uri: absolutizeDiscogsUrl(itemAnchor?.getAttribute("href") ?? ""),
    price: {
      value: price.value,
      currency: price.currency,
      display: formatMoney(price.value, price.currency)
    },
    sortPrice: Number.isFinite(price.value) ? price.value : Number.MAX_SAFE_INTEGER,
    seller
  };
}

function parsePriceFromContainer(container) {
  const candidates = [...container.querySelectorAll('[class*="price" i], td, span, strong, div')]
    .map((node) => stripText(node.textContent))
    .filter((text) => /[$\u20ac\u00a3]|\b(USD|EUR|GBP|CAD|AUD|SEK|JPY)\b/i.test(text))
    .filter((text) => !/shipping|about/i.test(text));

  for (const candidate of candidates) {
    const price = parsePriceText(candidate);

    if (Number.isFinite(price.value)) {
      return price;
    }
  }

  return parsePriceText(container.textContent);
}

function parseSeller(anchor, text) {
  const username = decodeURIComponent(extractUsername(anchor?.href ?? ""));
  const ratingMatch = text.match(/(\d+(?:\.\d+)?)\s*%/);
  const rating = ratingMatch ? Number(ratingMatch[1]) : Number.NaN;

  return {
    username,
    url: username ? `https://www.discogs.com/seller/${encodeURIComponent(username)}/profile` : "",
    rating
  };
}

function findSellerAnchor(container) {
  const anchors = [...container.querySelectorAll("a[href]")];
  return anchors.find((anchor) => {
    const href = anchor.getAttribute("href") ?? "";
    return !href.includes("/sell/item/") && (/\/seller\//.test(href) || /\/user\//.test(href));
  });
}

function getListingContainer(anchor) {
  let node = anchor;

  for (let depth = 0; depth < 9 && node; depth += 1) {
    const text = node.textContent ?? "";

    if (
      node !== anchor &&
      findSellerAnchor(node) &&
      (/add to cart|media condition|sleeve condition|seller|ships from|%/i.test(text) || node.matches("tr, li"))
    ) {
      return node;
    }

    node = node.parentElement;
  }

  return anchor.closest("tr, li, article, .shortcut_navigable, .card") || anchor.parentElement;
}

function hasNextPage(doc) {
  return Boolean(
    doc.querySelector('a[rel="next"], .pagination_next a, a.pagination_next, a[aria-label="Next"]')
  );
}

function extractField(text, pattern) {
  const match = text.match(pattern);
  return match ? stripText(match[1]).replace(/\s{2,}/g, " ") : "";
}

function extractCondition(text) {
  const match = text.match(/\b(Mint \(M\)|Near Mint \(NM or M-\)|Very Good Plus \(VG\+\)|Very Good \(VG\)|Good Plus \(G\+\)|Good \(G\)|Fair \(F\)|Poor \(P\))/i);
  return match?.[1] ?? "";
}

function extractUsername(href) {
  const match = href.match(/\/(?:seller|user)\/([^/?#]+)/);
  return match?.[1] ?? "";
}

function parseListingId(href) {
  const match = href.match(/\/sell\/item\/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function absolutizeDiscogsUrl(href) {
  if (!href) {
    return "";
  }

  try {
    return new URL(href, "https://www.discogs.com").toString();
  } catch {
    return "";
  }
}

function parseLeadingId(value) {
  const match = String(value ?? "").match(/^(\d+)/);
  const id = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function titleFromSlug(slug = "") {
  return String(slug)
    .replace(/^\d+-?/, "")
    .split("-")
    .filter(Boolean)
    .join(" ");
}

function stripText(text = "") {
  return String(text).replace(/\s+/g, " ").trim();
}

function uniqueNodes(nodes) {
  return [...new Set(nodes)];
}

function currencyFromSymbol(symbol) {
  return {
    "$": "USD",
    "\u20ac": "EUR",
    "\u00a3": "GBP"
  }[symbol] ?? "";
}

function clampNumber(value, min, max) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return min;
  }

  return Math.min(max, Math.max(min, numeric));
}

function optionalNumber(value) {
  if (value === "" || value === null || value === undefined) {
    return Number.NaN;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
