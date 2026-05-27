import test from "node:test";
import assert from "node:assert/strict";
import {
  createListingFilters,
  formatMoney,
  listingPassesFilters,
  normalizeListing,
  parseDiscogsItem,
  parseDiscogsItems,
  parseDiscogsSellers,
  rankSellerResults,
  searchListingsForSellerCandidates,
  searchListingsForReleases
} from "../src/discogs.js";

test("parseDiscogsItem handles release URLs", () => {
  assert.deepEqual(
    parseDiscogsItem("https://www.discogs.com/release/249504-Rick-Astley-Never-Gonna-Give-You-Up"),
    {
      type: "release",
      id: 249504,
      source: "https://www.discogs.com/release/249504-Rick-Astley-Never-Gonna-Give-You-Up"
    }
  );
});

test("parseDiscogsItem handles marketplace release and listing URLs", () => {
  assert.equal(parseDiscogsItem("https://www.discogs.com/sell/release/249504").id, 249504);
  assert.deepEqual(parseDiscogsItem("https://www.discogs.com/sell/item/123456789"), {
    type: "listing",
    id: 123456789,
    source: "https://www.discogs.com/sell/item/123456789"
  });
});

test("parseDiscogsItems deduplicates release IDs", () => {
  const parsed = parseDiscogsItems(`
    https://www.discogs.com/release/249504-title
    https://www.discogs.com/sell/release/249504
    397699
  `);

  assert.deepEqual(
    parsed.map((item) => `${item.type}:${item.id}`),
    ["release:249504", "release:397699"]
  );
});

test("parseDiscogsSellers handles usernames and seller profile URLs", () => {
  const parsed = parseDiscogsSellers(`
    Doveholes
    https://www.discogs.com/seller/Doveholes/profile
    https://www.discogs.com/user/OtherSeller
  `);

  assert.deepEqual(
    parsed.map((seller) => seller.username),
    ["Doveholes", "OtherSeller"]
  );
});

test("normalizeListing captures seller, price, and generated listing URL", () => {
  const listing = normalizeListing(
    {
      id: 88,
      condition: "Very Good Plus (VG+)",
      price: { value: 12.5, currency: "USD" },
      release: { format: "LP, Album" },
      seller: { username: "RecordShop", stats: { rating: "99.4" }, location: "United States" }
    },
    { id: 249504, displayTitle: "Artist - Title", format: "Vinyl LP" }
  );

  assert.equal(listing.seller.username, "RecordShop");
  assert.equal(listing.seller.rating, 99.4);
  assert.equal(listing.sortPrice, 12.5);
  assert.equal(listing.format, "LP, Album Vinyl LP");
  assert.equal(listing.shipsFrom, "United States");
  assert.equal(listing.uri, "https://www.discogs.com/sell/item/88");
});

test("listingPassesFilters applies ship-from, format, and maximum price filters", () => {
  const listing = normalizeListing(
    {
      id: 88,
      condition: "Near Mint (NM or M-)",
      price: { value: 18, currency: "USD" },
      release: { format: "LP, Album" },
      ships_from: { country: "United States" },
      seller: { username: "RecordShop", rating: "99.4" }
    },
    { id: 249504, displayTitle: "Artist - Title", format: "Vinyl LP" }
  );

  assert.equal(
    listingPassesFilters(
      listing,
      createListingFilters({ shipsFrom: "USA", format: "Vinyl", maximumPrice: "20" })
    ),
    true
  );
  assert.equal(
    listingPassesFilters(
      listing,
      createListingFilters({ shipsFrom: "Germany", format: "Vinyl", maximumPrice: "20" })
    ),
    false
  );
  assert.equal(
    listingPassesFilters(
      listing,
      createListingFilters({ shipsFrom: "USA", format: "CD", maximumPrice: "20" })
    ),
    false
  );
  assert.equal(
    listingPassesFilters(
      listing,
      createListingFilters({ shipsFrom: "USA", format: "Vinyl", maximumPrice: "15" })
    ),
    false
  );
});

test("listingPassesFilters treats LP listings as vinyl", () => {
  const listing = normalizeListing(
    {
      id: 88,
      condition: "Near Mint (NM or M-)",
      price: { value: 18, currency: "USD" },
      release: { format: "LP, Album" },
      seller: { username: "RecordShop", rating: "99.4" }
    },
    { id: 249504, displayTitle: "Artist - Title", format: "" }
  );

  assert.equal(
    listingPassesFilters(listing, createListingFilters({ format: "Vinyl" })),
    true
  );
});

test("rankSellerResults sorts complete cheaper sellers first", () => {
  const releases = [
    { id: 1, displayTitle: "A" },
    { id: 2, displayTitle: "B" }
  ];
  const sellerA = {
    username: "CompleteExpensive",
    rating: 99,
    url: "",
    listingsByRelease: new Map([
      [1, { sortPrice: 20 }],
      [2, { sortPrice: 20 }]
    ])
  };
  const sellerB = {
    username: "CompleteCheap",
    rating: 95,
    url: "",
    listingsByRelease: new Map([
      [1, { sortPrice: 10 }],
      [2, { sortPrice: 10 }]
    ])
  };
  const sellerC = {
    username: "Partial",
    rating: 100,
    url: "",
    listingsByRelease: new Map([[1, { sortPrice: 1 }]])
  };

  const ranked = rankSellerResults([sellerC, sellerA, sellerB], releases);

  assert.deepEqual(
    ranked.map((seller) => seller.username),
    ["CompleteCheap", "CompleteExpensive", "Partial"]
  );
});

test("searchListingsForReleases filters listings before ranking sellers", async () => {
  const releases = [{ id: 1, displayTitle: "A", format: "Vinyl LP" }];
  const calls = [];
  const client = {
    async searchMarketplace(params) {
      calls.push(params);
      return {
        data: {
          pagination: { pages: 1 },
          listings: [
            {
              id: 1,
              condition: "Near Mint (NM or M-)",
              price: { value: 12, currency: "USD" },
              ships_from: "United States",
              seller: { username: "USShop", rating: "99.5" }
            },
            {
              id: 2,
              condition: "Near Mint (NM or M-)",
              price: { value: 10, currency: "USD" },
              ships_from: "Germany",
              seller: { username: "GermanShop", rating: "99.5" }
            },
            {
              id: 3,
              condition: "Near Mint (NM or M-)",
              price: { value: 40, currency: "USD" },
              ships_from: "United States",
              seller: { username: "ExpensiveUSShop", rating: "99.5" }
            }
          ]
        }
      };
    }
  };

  const result = await searchListingsForReleases({
    client,
    releases,
    shipsFrom: "United States",
    format: "Vinyl",
    maximumPrice: "20"
  });

  assert.equal(calls[0].ships_from, "United States");
  assert.equal(calls[0].format, "Vinyl");
  assert.equal(calls[0].price_max, "20");
  assert.deepEqual(
    result.sellers.map((seller) => seller.username),
    ["USShop"]
  );
});

test("searchListingsForSellerCandidates finds complete matches from seller inventory", async () => {
  const releases = [
    { id: 4909657, displayTitle: "Finis Africae - El Secreto De Las 12", format: "Vinyl LP" },
    { id: 23554559, displayTitle: "Thomas Bush - Preludes", format: "Vinyl 12\"" }
  ];
  const calls = [];
  const client = {
    async fetchUserInventory(username, params) {
      calls.push({ username, params });
      return {
        data: {
          pagination: { pages: 1 },
          listings: [
            {
              id: 4034023267,
              condition: "Near Mint (NM or M-)",
              sleeve_condition: "Very Good Plus (VG+)",
              price: { value: 29, currency: "EUR" },
              ships_from: "Sweden",
              release: { id: 4909657, format: "LP, MiniAlbum, Comp" },
              seller: { username: "Doveholes", stats: { rating: "100.0" } }
            },
            {
              id: 4034024000,
              condition: "Near Mint (NM or M-)",
              sleeve_condition: "Very Good (VG)",
              price: { value: 25, currency: "EUR" },
              ships_from: "Sweden",
              release: { id: 23554559, format: "12\", Album" },
              seller: { username: "Doveholes", stats: { rating: "100.0" } }
            }
          ]
        }
      };
    }
  };

  const result = await searchListingsForSellerCandidates({
    client,
    releases,
    sellers: parseDiscogsSellers("Doveholes"),
    shipsFrom: "Sweden",
    format: "Vinyl",
    maximumPrice: "30"
  });

  assert.equal(calls[0].username, "Doveholes");
  assert.equal(calls[0].params.status, "For Sale");
  assert.equal(result.sellers[0].username, "Doveholes");
  assert.equal(result.sellers[0].isComplete, true);
  assert.equal(result.sellers[0].subtotal, 54);
});

test("formatMoney falls back for invalid currency codes", () => {
  assert.equal(formatMoney(12, "BADCODE"), "12.00 BADCODE");
});
