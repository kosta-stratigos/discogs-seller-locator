import test from "node:test";
import assert from "node:assert/strict";
import {
  formatMoney,
  normalizeListing,
  parseDiscogsItem,
  parseDiscogsItems,
  rankSellerResults
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

test("normalizeListing captures seller, price, and generated listing URL", () => {
  const listing = normalizeListing(
    {
      id: 88,
      condition: "Very Good Plus (VG+)",
      price: { value: 12.5, currency: "USD" },
      seller: { username: "RecordShop", rating: "99.4" }
    },
    { id: 249504, displayTitle: "Artist - Title" }
  );

  assert.equal(listing.seller.username, "RecordShop");
  assert.equal(listing.seller.rating, 99.4);
  assert.equal(listing.sortPrice, 12.5);
  assert.equal(listing.uri, "https://www.discogs.com/sell/item/88");
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

test("formatMoney falls back for invalid currency codes", () => {
  assert.equal(formatMoney(12, "BADCODE"), "12.00 BADCODE");
});
