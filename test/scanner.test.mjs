import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMarketplaceUrl,
  formatMoney,
  parseDiscogsReleaseUrl,
  parsePriceText,
  rankSharedSellers
} from "../src/scanner.js";

test("parseDiscogsReleaseUrl handles release and sell release URLs", () => {
  assert.deepEqual(
    parseDiscogsReleaseUrl("https://www.discogs.com/release/4909657-Finis-Africae-El-Secreto-De-Las-12"),
    {
      id: 4909657,
      title: "Finis Africae El Secreto De Las 12",
      url: "https://www.discogs.com/release/4909657"
    }
  );

  assert.equal(parseDiscogsReleaseUrl("https://www.discogs.com/sell/release/23554559").id, 23554559);
  assert.equal(parseDiscogsReleaseUrl("https://example.com/release/1"), null);
});

test("buildMarketplaceUrl creates Discogs sale page URLs", () => {
  assert.equal(
    buildMarketplaceUrl(4909657, 2, 250),
    "https://www.discogs.com/sell/release/4909657?limit=250&page=2&sort=price%2Casc"
  );
});

test("parsePriceText supports common marketplace price formats", () => {
  assert.deepEqual(parsePriceText("\u20ac29.00 + shipping"), { value: 29, currency: "EUR" });
  assert.deepEqual(parsePriceText("$34.50"), { value: 34.5, currency: "USD" });
  assert.deepEqual(parsePriceText("25.00 GBP"), { value: 25, currency: "GBP" });
});

test("rankSharedSellers ranks complete cheaper sellers first", () => {
  const releases = [
    { id: 1, title: "A" },
    { id: 2, title: "B" }
  ];
  const listingsByRelease = new Map([
    [
      1,
      [
        listing("SellerA", 1, 20),
        listing("SellerB", 1, 8),
        listing("Partial", 1, 5)
      ]
    ],
    [
      2,
      [
        listing("SellerA", 2, 15),
        listing("SellerB", 2, 12)
      ]
    ]
  ]);

  const ranked = rankSharedSellers(releases, listingsByRelease);

  assert.deepEqual(
    ranked.map((seller) => `${seller.username}:${seller.matchedCount}:${seller.subtotal}`),
    ["SellerB:2:20", "SellerA:2:35", "Partial:1:5"]
  );
});

test("formatMoney falls back for invalid currency codes", () => {
  assert.equal(formatMoney(12, "BADCODE"), "12.00 BADCODE");
});

function listing(username, releaseId, price) {
  return {
    id: Number(`${releaseId}${price}`),
    releaseId,
    sortPrice: price,
    price: { value: price, currency: "USD", display: `$${price}` },
    seller: {
      username,
      rating: 99,
      url: `https://www.discogs.com/seller/${username}/profile`
    }
  };
}
