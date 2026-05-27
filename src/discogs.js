export const API_BASE_URL = "https://api.discogs.com";

const ITEM_SPLIT_PATTERN = /[\n,]+/;
const SELLER_SPLIT_PATTERN = /[\n,;]+/;

export class DiscogsApiError extends Error {
  constructor(message, { status = 0, payload = null } = {}) {
    super(message);
    this.name = "DiscogsApiError";
    this.status = status;
    this.payload = payload;
  }
}

export function parseDiscogsItem(value) {
  const source = String(value ?? "").trim();

  if (!source) {
    return { type: "unknown", source, error: "Empty item" };
  }

  const asUrl = coerceDiscogsUrl(source);

  if (asUrl) {
    const parts = asUrl.pathname.split("/").filter(Boolean);
    const releaseId = getPathId(parts, "release");
    const masterId = getPathId(parts, "master");

    if (parts[0] === "sell" && parts[1] === "item") {
      return idResult("listing", parts[2], source);
    }

    if (parts[0] === "sell" && parts[1] === "release") {
      return idResult("release", parts[2], source);
    }

    if (releaseId) {
      return { type: "release", id: releaseId, source };
    }

    if (masterId) {
      return { type: "master", id: masterId, source };
    }

    const queryRelease = parseNumericId(asUrl.searchParams.get("release_id"));
    const queryMaster = parseNumericId(asUrl.searchParams.get("master_id"));

    if (queryRelease) {
      return { type: "release", id: queryRelease, source };
    }

    if (queryMaster) {
      return { type: "master", id: queryMaster, source };
    }
  }

  const directId = parseNumericId(source);

  if (directId) {
    return { type: "release", id: directId, source };
  }

  return { type: "unknown", source, error: "Could not find a Discogs release, master, or listing ID" };
}

export function parseDiscogsItems(input) {
  const parsed = String(input ?? "")
    .split(ITEM_SPLIT_PATTERN)
    .map(parseDiscogsItem)
    .filter((item) => item.source);

  return dedupeParsedItems(parsed);
}

export function parseDiscogsSeller(value) {
  const source = String(value ?? "").trim();

  if (!source) {
    return { username: "", source, error: "Empty seller" };
  }

  const asUrl = coerceDiscogsUrl(source);

  if (asUrl) {
    const parts = asUrl.pathname.split("/").filter(Boolean);
    const sellerIndex = parts.indexOf("seller");
    const userIndex = parts.indexOf("user");
    const usersIndex = parts.indexOf("users");

    if (sellerIndex >= 0 && parts[sellerIndex + 1]) {
      return sellerResult(parts[sellerIndex + 1], source);
    }

    if (userIndex >= 0 && parts[userIndex + 1]) {
      return sellerResult(parts[userIndex + 1], source);
    }

    if (usersIndex >= 0 && parts[usersIndex + 1]) {
      return sellerResult(parts[usersIndex + 1], source);
    }
  }

  return sellerResult(source.replace(/^@/, ""), source);
}

export function parseDiscogsSellers(input) {
  const sellers = String(input ?? "")
    .split(SELLER_SPLIT_PATTERN)
    .map(parseDiscogsSeller)
    .filter((seller) => seller.username);
  const seen = new Set();
  const deduped = [];

  for (const seller of sellers) {
    const key = seller.username.toLowerCase();

    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(seller);
    }
  }

  return deduped;
}

export function createDiscogsClient({ token = "", fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }

  async function request(path, params = {}) {
    const url = new URL(path, API_BASE_URL);

    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });

    const headers = {
      Accept: "application/vnd.discogs.v2.discogs+json"
    };

    if (token.trim()) {
      headers.Authorization = `Discogs token=${token.trim()}`;
    }

    const response = await fetchImpl(url, { headers });
    const text = await response.text();
    const payload = text ? safeJsonParse(text) : null;

    if (!response.ok) {
      const message = payload?.message ?? `Discogs API request failed with ${response.status}`;
      throw new DiscogsApiError(message, { status: response.status, payload });
    }

    return {
      data: payload,
      rate: {
        limit: response.headers.get("x-discogs-ratelimit"),
        remaining: response.headers.get("x-discogs-ratelimit-remaining"),
        used: response.headers.get("x-discogs-ratelimit-used")
      }
    };
  }

  return {
    request,
    async fetchRelease(id) {
      return request(`/releases/${id}`);
    },
    async fetchMaster(id) {
      return request(`/masters/${id}`);
    },
    async fetchListing(id) {
      return request(`/marketplace/listings/${id}`);
    },
    async fetchUserInventory(username, params = {}) {
      return request(`/users/${encodeURIComponent(username)}/inventory`, params);
    },
    async searchMarketplace(params) {
      return request("/marketplace/search", params);
    }
  };
}

export async function resolveRequestedItem(item, client) {
  if (item.type === "release") {
    const response = await client.fetchRelease(item.id);
    return {
      item,
      release: normalizeRelease(response.data),
      rate: response.rate
    };
  }

  if (item.type === "master") {
    const masterResponse = await client.fetchMaster(item.id);
    const releaseId = masterResponse.data?.main_release;

    if (!releaseId) {
      throw new DiscogsApiError(`Master ${item.id} does not include a main release.`);
    }

    const releaseResponse = await client.fetchRelease(releaseId);

    return {
      item,
      release: {
        ...normalizeRelease(releaseResponse.data),
        resolvedFrom: `master ${item.id}`
      },
      rate: releaseResponse.rate
    };
  }

  if (item.type === "listing") {
    const listingResponse = await client.fetchListing(item.id);
    const releaseId = listingResponse.data?.release?.id;

    if (!releaseId) {
      throw new DiscogsApiError(`Listing ${item.id} does not include a release ID.`);
    }

    const releaseResponse = await client.fetchRelease(releaseId);

    return {
      item,
      release: {
        ...normalizeRelease(releaseResponse.data),
        resolvedFrom: `listing ${item.id}`
      },
      rate: releaseResponse.rate
    };
  }

  throw new DiscogsApiError(item.error ?? "Unsupported Discogs item.");
}

export async function searchListingsForReleases({
  client,
  releases,
  pageLimit = 5,
  minimumRating = 0,
  shipsFrom = "",
  format = "",
  maximumPrice = "",
  onProgress = () => {}
}) {
  const sellers = new Map();
  const releaseCount = releases.length;
  const safePageLimit = clampNumber(pageLimit, 1, 20);
  const ratingFloor = clampNumber(minimumRating, 0, 100);
  const listingFilters = createListingFilters({ shipsFrom, format, maximumPrice });
  const warnings = [];

  for (const [releaseIndex, release] of releases.entries()) {
    let totalPages = 1;
    let page = 1;

    while (page <= Math.min(totalPages, safePageLimit)) {
      onProgress({
        release,
        releaseIndex,
        releaseCount,
        page,
        totalPages: Math.min(totalPages, safePageLimit)
      });

      const response = await client.searchMarketplace({
        release_id: release.id,
        page,
        per_page: 100,
        sort: "price",
        sort_order: "asc",
        ships_from: shipsFrom,
        format,
        price_max: maximumPrice
      });

      const payload = response.data ?? {};
      const listings = Array.isArray(payload.listings) ? payload.listings : [];

      totalPages = Math.max(1, Number(payload.pagination?.pages) || 1);

      for (const listing of listings) {
        const normalized = normalizeListing(listing, release);

        if (
          !normalized.seller.username ||
          normalized.seller.rating < ratingFloor ||
          !listingPassesFilters(normalized, listingFilters)
        ) {
          continue;
        }

        const seller = getOrCreateSeller(sellers, normalized.seller);
        const existing = seller.listingsByRelease.get(release.id);

        if (!existing || normalized.sortPrice < existing.sortPrice) {
          seller.listingsByRelease.set(release.id, normalized);
        }
      }

      page += 1;
    }

    if (totalPages > safePageLimit) {
      warnings.push(
        `${release.displayTitle} had ${totalPages} marketplace pages; scanned ${safePageLimit}.`
      );
    }
  }

  return {
    sellers: rankSellerResults([...sellers.values()], releases),
    warnings,
    releaseCount
  };
}

export async function searchListingsForSellerCandidates({
  client,
  releases,
  sellers,
  pageLimit = 5,
  minimumRating = 0,
  shipsFrom = "",
  format = "",
  maximumPrice = "",
  onProgress = () => {}
}) {
  const sellerResults = new Map();
  const releaseMap = new Map(releases.map((release) => [release.id, release]));
  const safePageLimit = clampNumber(pageLimit, 1, 20);
  const ratingFloor = clampNumber(minimumRating, 0, 100);
  const listingFilters = createListingFilters({ shipsFrom, format, maximumPrice });
  const warnings = [];

  for (const [sellerIndex, seller] of sellers.entries()) {
    let totalPages = 1;
    let page = 1;

    while (page <= Math.min(totalPages, safePageLimit)) {
      onProgress({
        seller,
        sellerIndex,
        sellerCount: sellers.length,
        page,
        totalPages: Math.min(totalPages, safePageLimit)
      });

      const response = await client.fetchUserInventory(seller.username, {
        status: "For Sale",
        page,
        per_page: 100
      });
      const payload = response.data ?? {};
      const listings = Array.isArray(payload.listings) ? payload.listings : [];

      totalPages = Math.max(1, Number(payload.pagination?.pages) || 1);

      for (const listing of listings) {
        const releaseId = getListingReleaseId(listing);
        const release = releaseMap.get(releaseId);

        if (!release) {
          continue;
        }

        const normalized = normalizeListing(listing, release, { username: seller.username });

        if (
          !normalized.seller.username ||
          normalized.seller.rating < ratingFloor ||
          !listingPassesFilters(normalized, listingFilters)
        ) {
          continue;
        }

        const matchedSeller = getOrCreateSeller(sellerResults, normalized.seller);
        const existing = matchedSeller.listingsByRelease.get(release.id);

        if (!existing || normalized.sortPrice < existing.sortPrice) {
          matchedSeller.listingsByRelease.set(release.id, normalized);
        }
      }

      page += 1;
    }

    if (totalPages > safePageLimit) {
      warnings.push(
        `${seller.username} had ${totalPages} inventory pages; scanned ${safePageLimit}.`
      );
    }
  }

  return {
    sellers: rankSellerResults([...sellerResults.values()], releases),
    warnings,
    releaseCount: releases.length
  };
}

export function rankSellerResults(sellers, releases) {
  const releaseIds = releases.map((release) => release.id);

  return sellers
    .map((seller) => {
      const listings = releaseIds
        .map((releaseId) => seller.listingsByRelease.get(releaseId))
        .filter(Boolean);
      const subtotal = listings.reduce((sum, listing) => sum + listing.sortPrice, 0);

      return {
        ...seller,
        listings,
        matchedCount: listings.length,
        missingCount: releaseIds.length - listings.length,
        isComplete: listings.length === releaseIds.length,
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

export function normalizeRelease(release) {
  const artist = release.artists_sort || formatArtists(release.artists);
  const title = release.title || "Untitled release";
  const image =
    release.thumb ||
    release.images?.find((candidate) => candidate.type === "primary")?.uri150 ||
    release.images?.[0]?.uri150 ||
    "";

  return {
    id: Number(release.id),
    artist,
    title,
    displayTitle: artist ? `${artist} - ${title}` : title,
    year: release.year || "",
    country: release.country || "",
    format: formatReleaseFormats(release.formats),
    uri: release.uri || `https://www.discogs.com/release/${release.id}`,
    image,
    numForSale: Number(release.num_for_sale) || 0,
    lowestPrice: Number(release.lowest_price) || 0
  };
}

export function normalizeListing(listing, release, fallbackSeller = {}) {
  const seller = { ...fallbackSeller, ...(listing.seller ?? {}) };
  const sellerUsername = seller.username || seller.name || "";
  const sellerUrl = seller.html_url ||
    (sellerUsername ? `https://www.discogs.com/seller/${encodeURIComponent(sellerUsername)}/profile` : "");
  const price = listing.price ?? {};
  const shipping = listing.shipping_price ?? {};
  const value = numericPrice(price.value ?? price);
  const currency = price.currency || shipping.currency || "";
  const shipsFrom = formatLocation(
    listing.ships_from ??
      listing.ships_from_location ??
      listing.location ??
      seller.ships_from ??
      seller.location
  );
  const listingFormat = [formatListingRelease(listing.release), release.format]
    .filter(Boolean)
    .join(" ");

  return {
    id: Number(listing.id),
    releaseId: release.id,
    releaseTitle: release.displayTitle,
    format: listingFormat,
    condition: listing.condition || "Condition unavailable",
    sleeveCondition: listing.sleeve_condition || "",
    comments: listing.comments || "",
    shipsFrom,
    uri: listing.uri || `https://www.discogs.com/sell/item/${listing.id}`,
    price: {
      value,
      currency,
      display: formatMoney(value, currency)
    },
    sortPrice: Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER,
    seller: {
      username: sellerUsername,
      rating: Number(seller.rating ?? seller.stats?.rating) || 0,
      url: sellerUrl
    }
  };
}

export function createListingFilters({ shipsFrom = "", format = "", maximumPrice = "" } = {}) {
  const shipsFromTerms = String(shipsFrom)
    .split(/[,;\n]+/)
    .flatMap((term) => expandLocationTerm(term))
    .map(normalizeSearchText)
    .filter(Boolean);
  const uniqueShipTerms = [...new Set(shipsFromTerms)];
  const maximum = optionalNumber(maximumPrice);

  return {
    shipsFromTerms: uniqueShipTerms,
    format: normalizeSearchText(format),
    formatTerms: expandFormatTerm(format).map(normalizeSearchText).filter(Boolean),
    maximumPrice: maximum,
    hasAny: Boolean(uniqueShipTerms.length || format || Number.isFinite(maximum))
  };
}

export function listingPassesFilters(listing, filters = {}) {
  if (
    Number.isFinite(filters.maximumPrice) &&
    (!Number.isFinite(listing.price.value) || listing.price.value > filters.maximumPrice)
  ) {
    return false;
  }

  if (
    filters.formatTerms?.length &&
    !filters.formatTerms.some((term) => normalizeSearchText(listing.format).includes(term))
  ) {
    return false;
  }

  if (filters.shipsFromTerms?.length && !locationMatches(listing.shipsFrom, filters.shipsFromTerms)) {
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

function coerceDiscogsUrl(value) {
  try {
    const url = new URL(value);
    return isDiscogsHost(url.hostname) ? url : null;
  } catch {
    try {
      const url = new URL(`https://${value}`);
      return isDiscogsHost(url.hostname) ? url : null;
    } catch {
      return null;
    }
  }
}

function isDiscogsHost(hostname) {
  return /(^|\.)discogs\.com$/i.test(hostname);
}

function getPathId(parts, key) {
  const index = parts.indexOf(key);
  return index >= 0 ? parseNumericId(parts[index + 1]) : null;
}

function idResult(type, rawId, source) {
  const id = parseNumericId(rawId);
  return id
    ? { type, id, source }
    : { type: "unknown", source, error: `Could not parse ${type} ID` };
}

function sellerResult(rawUsername, source) {
  const username = decodeURIComponent(String(rawUsername ?? "")).trim();

  return username
    ? { username, source }
    : { username: "", source, error: "Could not parse seller username" };
}

function parseNumericId(value) {
  const match = String(value ?? "").match(/^(\d+)/);
  const id = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function dedupeParsedItems(items) {
  const seen = new Set();
  const deduped = [];

  for (const item of items) {
    const key = `${item.type}:${item.id ?? item.source}`;

    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }

  return deduped;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
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
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : Number.NaN;
}

function getOrCreateSeller(sellers, seller) {
  const key = seller.username.toLowerCase();

  if (!sellers.has(key)) {
    sellers.set(key, {
      username: seller.username,
      rating: seller.rating,
      url: seller.url,
      listingsByRelease: new Map()
    });
  }

  const existing = sellers.get(key);
  existing.rating = Math.max(existing.rating, seller.rating);
  return existing;
}

function numericPrice(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function getListingReleaseId(listing) {
  const id = Number(listing.release?.id);

  if (Number.isSafeInteger(id) && id > 0) {
    return id;
  }

  const match = String(listing.release?.resource_url ?? listing.resource_url ?? "").match(/\/releases\/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function formatLocation(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "object") {
    return [
      value.city,
      value.region,
      value.state,
      value.country,
      value.name,
      value.location
    ]
      .filter(Boolean)
      .join(", ");
  }

  return String(value).trim();
}

function formatListingRelease(release = {}) {
  if (!release) {
    return "";
  }

  if (typeof release.format === "string") {
    return release.format;
  }

  if (Array.isArray(release.formats)) {
    return formatReleaseFormats(release.formats);
  }

  if (Array.isArray(release.format)) {
    return release.format.filter(Boolean).join(" ");
  }

  return "";
}

function expandLocationTerm(term) {
  const normalized = normalizeSearchText(term);

  if (!normalized) {
    return [];
  }

  const aliases = {
    us: ["us", "usa", "united states", "united states of america"],
    usa: ["us", "usa", "united states", "united states of america"],
    "u s": ["us", "usa", "united states", "united states of america"],
    "united states": ["us", "usa", "united states", "united states of america"],
    uk: ["uk", "united kingdom", "great britain"],
    "u k": ["uk", "united kingdom", "great britain"],
    "united kingdom": ["uk", "united kingdom", "great britain"]
  };

  return aliases[normalized] ?? [term];
}

function expandFormatTerm(format) {
  const normalized = normalizeSearchText(format);

  if (!normalized) {
    return [];
  }

  const aliases = {
    vinyl: ["vinyl", "lp", "12", "10", "7"],
    cd: ["cd", "cdr", "cd r"],
    cassette: ["cassette", "cass"],
    shellac: ["shellac"],
    dvd: ["dvd"],
    "blu ray": ["blu ray", "bluray"],
    file: ["file"],
    "8 track cartridge": ["8 track cartridge", "8 track"],
    "reel to reel": ["reel to reel", "reel"]
  };

  return aliases[normalized] ?? [format];
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

function locationMatches(location, terms) {
  const normalizedLocation = normalizeSearchText(location);

  if (!normalizedLocation) {
    return false;
  }

  const words = normalizedLocation.split(" ");

  return terms.some((term) => {
    if (term.length <= 2) {
      return words.includes(term);
    }

    return normalizedLocation.includes(term);
  });
}

function formatArtists(artists = []) {
  return artists
    .map((artist) => artist.name)
    .filter(Boolean)
    .join(", ");
}

function formatReleaseFormats(formats = []) {
  return formats
    .map((format) => {
      const descriptions = Array.isArray(format.descriptions)
        ? format.descriptions.join(", ")
        : "";
      return [format.name, descriptions].filter(Boolean).join(" ");
    })
    .filter(Boolean)
    .join("; ");
}
