import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMasterVersionsUrl,
  buildMarketplaceUrl,
  fetchMasterVersions,
  formatMoney,
  parseDiscogsReleaseUrl,
  parseDiscogsTargetUrl,
  parsePriceText,
  rankSharedSellers,
  resolveScanTargets
} from "../src/scanner.js";

test("parseDiscogsReleaseUrl handles release and sell release URLs", () => {
  assert.deepEqual(
    parseDiscogsReleaseUrl("https://www.discogs.com/release/4909657-Finis-Africae-El-Secreto-De-Las-12"),
    {
      type: "release",
      id: 4909657,
      key: "release:4909657",
      title: "Finis Africae El Secreto De Las 12",
      url: "https://www.discogs.com/release/4909657"
    }
  );

  assert.equal(parseDiscogsReleaseUrl("https://www.discogs.com/sell/release/23554559").id, 23554559);
  assert.equal(parseDiscogsReleaseUrl("https://example.com/release/1"), null);
});

test("parseDiscogsTargetUrl handles master URLs", () => {
  assert.deepEqual(
    parseDiscogsTargetUrl("https://www.discogs.com/master/651410-Finis-Africae-El-Secreto-De-Las-12"),
    {
      type: "master",
      id: 651410,
      key: "master:651410",
      title: "Finis Africae El Secreto De Las 12",
      url: "https://www.discogs.com/master/651410"
    }
  );
});

test("buildMarketplaceUrl creates Discogs sale page URLs", () => {
  assert.equal(
    buildMarketplaceUrl(4909657, 2, 250),
    "https://www.discogs.com/sell/release/4909657?limit=250&page=2&sort=price%2Casc"
  );
});

test("buildMasterVersionsUrl creates Discogs API version URLs", () => {
  assert.equal(
    buildMasterVersionsUrl(651410, 2, 25),
    "https://api.discogs.com/masters/651410/versions?page=2&per_page=25"
  );
});

test("fetchMasterVersions normalizes version records", async () => {
  const urls = [];
  const versions = await fetchMasterVersions(651410, 2, async (url) => {
    urls.push(url);
    return {
      pagination: { pages: 1 },
      versions: [
        {
          id: 4909657,
          title: "El Secreto De Las 12",
          format: "LP, Compilation",
          country: "Japan",
          released: "2013"
        },
        {
          id: 5375859,
          title: "El Secreto De Las 12",
          format: "CD, Compilation",
          country: "Japan",
          released: "2013"
        }
      ]
    };
  });

  assert.equal(urls[0], "https://api.discogs.com/masters/651410/versions?page=1&per_page=2");
  assert.deepEqual(versions, [
    {
      type: "release",
      id: 4909657,
      key: "release:4909657",
      title: "El Secreto De Las 12",
      subtitle: "LP, Compilation / Japan / 2013",
      url: "https://www.discogs.com/release/4909657"
    },
    {
      type: "release",
      id: 5375859,
      key: "release:5375859",
      title: "El Secreto De Las 12",
      subtitle: "CD, Compilation / Japan / 2013",
      url: "https://www.discogs.com/release/5375859"
    }
  ]);
});

test("resolveScanTargets expands masters and preserves exact releases", async () => {
  const targets = await resolveScanTargets({
    targets: [
      parseDiscogsTargetUrl("https://www.discogs.com/master/651410-Finis-Africae-El-Secreto-De-Las-12"),
      parseDiscogsTargetUrl("https://www.discogs.com/release/23554559-Thomas-Bush-Preludes")
    ],
    versionLimit: 1,
    fetchJson: async () => ({
      pagination: { pages: 1 },
      versions: [{ id: 4909657, title: "El Secreto De Las 12", format: "LP" }]
    })
  });

  assert.equal(targets[0].type, "master");
  assert.equal(targets[0].releases[0].id, 4909657);
  assert.equal(targets[1].type, "release");
  assert.equal(targets[1].releases[0].id, 23554559);
});

test("parsePriceText supports common marketplace price formats", () => {
  assert.deepEqual(parsePriceText("\u20ac29.00 + shipping"), { value: 29, currency: "EUR" });
  assert.deepEqual(parsePriceText("$34.50"), { value: 34.5, currency: "USD" });
  assert.deepEqual(parsePriceText("25.00 GBP"), { value: 25, currency: "GBP" });
});

test("rankSharedSellers ranks complete cheaper sellers first", () => {
  const releases = [
    { type: "release", id: 1, key: "release:1", title: "A" },
    { type: "master", id: 2, key: "master:2", title: "B" }
  ];
  const listingsByRelease = new Map([
    [
      "release:1",
      [
        listing("SellerA", 1, 20),
        listing("SellerB", 1, 8),
        listing("Partial", 1, 5)
      ]
    ],
    [
      "master:2",
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
