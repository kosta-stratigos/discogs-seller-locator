export function parseDiscogsReleaseUrl(value) {
  const target = parseDiscogsTargetUrl(value);
  return target?.type === "release" ? target : null;
}

export function parseDiscogsTargetUrl(value) {
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
    const masterIndex = parts.indexOf("master");
    const sellReleaseIndex = parts[0] === "sell" && parts[1] === "release" ? 1 : -1;
    const type = masterIndex >= 0 ? "master" : "release";
    const idSource = masterIndex >= 0
      ? parts[masterIndex + 1]
      : releaseIndex >= 0
        ? parts[releaseIndex + 1]
        : parts[sellReleaseIndex + 1];
    const id = parseLeadingId(idSource);

    if (!id) {
      return null;
    }

    return {
      type,
      id,
      key: makeTargetKey({ type, id }),
      title: titleFromSlug(idSource) || `Discogs ${type} ${id}`,
      url: `https://www.discogs.com/${type}/${id}`
    };
  } catch {
    return null;
  }
}

export function buildMasterVersionsUrl(masterId, page = 1, perPage = 100) {
  const url = new URL(`https://api.discogs.com/masters/${masterId}/versions`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(perPage));
  return url.toString();
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
  versionLimit = 25,
  fetchPage,
  fetchJson,
  onProgress = () => {}
}) {
  const safePageLimit = clampNumber(pageLimit, 1, 20);
  const targets = await resolveScanTargets({
    targets: releases,
    versionLimit,
    fetchJson
  });
  const listingsByTarget = new Map();
  const warnings = [];

  for (const [targetIndex, target] of targets.entries()) {
    const targetListings = [];

    for (const [candidateIndex, candidate] of target.releases.entries()) {
      for (let page = 1; page <= safePageLimit; page += 1) {
        onProgress({
          target,
          candidate,
          targetIndex,
          targetCount: targets.length,
          candidateIndex,
          candidateCount: target.releases.length,
          page,
          totalPages: safePageLimit
        });

        const html = await fetchPage(buildMarketplaceUrl(candidate.id, page));
        const parsed = parseMarketplaceHtml(html, candidate, target);
        targetListings.push(...parsed.listings.filter((listing) => listingPassesFilters(listing, filters)));

        if (!parsed.hasNextPage) {
          break;
        }
      }
    }

    if (!targetListings.length) {
      warnings.push(`No listings found for ${target.title}.`);
    }

    listingsByTarget.set(target.key, targetListings);
  }

  return {
    targets,
    sellers: rankSharedSellers(targets, listingsByTarget),
    listingsByTarget,
    listingsByRelease: listingsByTarget,
    warnings
  };
}

export async function resolveScanTargets({ targets, versionLimit = 25, fetchJson } = {}) {
  const safeVersionLimit = clampNumber(versionLimit, 1, 100);
  const resolved = [];

  for (const rawTarget of targets ?? []) {
    const target = normalizeTarget(rawTarget);

    if (target.type === "master") {
      if (typeof fetchJson !== "function") {
        throw new TypeError("A fetchJson implementation is required to scan master releases.");
      }

      const versions = await fetchMasterVersions(target.id, safeVersionLimit, fetchJson);
      resolved.push({
        ...target,
        releases: versions
      });
    } else {
      resolved.push({
        ...target,
        releases: [targetToRelease(target)]
      });
    }
  }

  return resolved;
}

export async function fetchMasterVersions(masterId, versionLimit, fetchJson) {
  const versions = [];
  const perPage = Math.min(100, Math.max(1, versionLimit));
  let page = 1;
  let totalPages = 1;

  while (versions.length < versionLimit && page <= totalPages) {
    const payload = await fetchJson(buildMasterVersionsUrl(masterId, page, perPage));
    totalPages = Math.max(1, Number(payload?.pagination?.pages) || 1);

    for (const version of payload?.versions ?? []) {
      if (versions.length >= versionLimit) {
        break;
      }

      versions.push({
        type: "release",
        id: Number(version.id),
        key: makeTargetKey({ type: "release", id: Number(version.id) }),
        title: version.title || `Discogs release ${version.id}`,
        subtitle: [version.format, version.country, version.released].filter(Boolean).join(" / "),
        url: `https://www.discogs.com/release/${version.id}`
      });
    }

    page += 1;
  }

  return versions;
}

export function parseMarketplaceHtml(html, release, target = release) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const listingAnchors = [...doc.querySelectorAll('a[href*="/sell/item/"]')];
  const containers = uniqueNodes(listingAnchors.map(getListingContainer).filter(Boolean));
  const listings = containers
    .map((container) => parseListingContainer(container, release, target))
    .filter((listing) => listing.id && listing.seller.username);

  return {
    listings,
    hasNextPage: hasNextPage(doc)
  };
}

export function rankSharedSellers(releases, listingsByRelease) {
  const targets = releases.map(normalizeTarget);
  const sellers = new Map();

  for (const target of targets) {
    const listings = listingsByRelease.get(target.key) ?? listingsByRelease.get(target.id) ?? [];

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
      const existing = seller.listingsByRelease.get(target.key);
      seller.rating = Math.max(seller.rating, listing.seller.rating ?? 0);

      if (!existing || listing.sortPrice < existing.sortPrice) {
        seller.listingsByRelease.set(target.key, listing);
      }
    }
  }

  return [...sellers.values()]
    .map((seller) => {
      const listings = targets
        .map((target) => seller.listingsByRelease.get(target.key))
        .filter(Boolean);
      const subtotal = listings.reduce((sum, listing) => sum + listing.sortPrice, 0);

      return {
        ...seller,
        listings,
        matchedCount: listings.length,
        missingCount: targets.length - listings.length,
        isComplete: listings.length === targets.length,
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

function parseListingContainer(container, release, target) {
  const text = stripText(container.textContent);
  const itemAnchor = container.querySelector('a[href*="/sell/item/"]');
  const sellerAnchor = findSellerAnchor(container);
  const price = parsePriceFromContainer(container);
  const seller = parseSeller(sellerAnchor, text);

  return {
    id: parseListingId(itemAnchor?.href ?? ""),
    targetId: target.id,
    targetKey: target.key,
    targetTitle: target.title,
    releaseId: release.id,
    releaseTitle: release.title,
    releaseUrl: release.url,
    releaseSubtitle: release.subtitle ?? "",
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

function normalizeTarget(target) {
  const type = target?.type === "master" ? "master" : "release";
  const id = Number(target?.id);

  return {
    ...target,
    type,
    id,
    key: target?.key || makeTargetKey({ type, id }),
    title: target?.title || `Discogs ${type} ${id}`,
    url: target?.url || `https://www.discogs.com/${type}/${id}`
  };
}

function targetToRelease(target) {
  return {
    type: "release",
    id: target.id,
    key: makeTargetKey({ type: "release", id: target.id }),
    title: target.title,
    subtitle: target.subtitle ?? "",
    url: target.url
  };
}

function makeTargetKey(target) {
  return `${target.type === "master" ? "master" : "release"}:${Number(target.id)}`;
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
