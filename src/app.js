import {
  DiscogsApiError,
  createDiscogsClient,
  formatMoney,
  parseDiscogsItems,
  resolveRequestedItem,
  searchListingsForReleases
} from "./discogs.js";

const SAMPLE_STACK = [
  "https://www.discogs.com/release/249504-Rick-Astley-Never-Gonna-Give-You-Up",
  "https://www.discogs.com/release/397699-Rick-Astley-Whenever-You-Need-Somebody"
].join("\n");

const elements = {
  form: document.querySelector("#locator-form"),
  itemInput: document.querySelector("#item-input"),
  tokenInput: document.querySelector("#token-input"),
  pageLimitInput: document.querySelector("#page-limit-input"),
  ratingInput: document.querySelector("#rating-input"),
  scanButton: document.querySelector("#scan-button"),
  sampleButton: document.querySelector("#sample-button"),
  clearButton: document.querySelector("#clear-button"),
  itemCount: document.querySelector("#item-count"),
  statusText: document.querySelector("#status-text"),
  rateText: document.querySelector("#rate-text"),
  releaseSummary: document.querySelector("#release-summary"),
  sellerSummary: document.querySelector("#seller-summary"),
  releaseList: document.querySelector("#release-list"),
  sellerList: document.querySelector("#seller-list")
};

let currentReleases = [];

elements.itemInput.addEventListener("input", updateItemCount);
elements.form.addEventListener("submit", handleSubmit);
elements.sampleButton.addEventListener("click", () => {
  elements.itemInput.value = SAMPLE_STACK;
  updateItemCount();
  elements.itemInput.focus();
});
elements.clearButton.addEventListener("click", resetApp);

updateItemCount();

async function handleSubmit(event) {
  event.preventDefault();

  const items = parseDiscogsItems(elements.itemInput.value);
  const token = elements.tokenInput.value.trim();

  if (!items.length) {
    setStatus("Add at least one Discogs item link.");
    renderNotice(elements.releaseList, "Add release, marketplace release, master, or listing links.");
    return;
  }

  setBusy(true);
  setStatus("Loading requested items.");
  elements.rateText.textContent = "";
  elements.sellerSummary.textContent = "Waiting";
  renderNotice(elements.sellerList, "Marketplace scan will start after item details load.");

  try {
    const client = createDiscogsClient({ token });
    currentReleases = await loadReleases(items, client);
    renderReleases(currentReleases);

    if (!token) {
      setStatus("Add a Discogs personal access token to scan marketplace sellers.");
      renderNotice(
        elements.sellerList,
        "Release data loaded. Seller matching needs authenticated Discogs marketplace search."
      );
      elements.sellerSummary.textContent = "Token required";
      return;
    }

    setStatus("Scanning marketplace listings.");

    const searchResult = await searchListingsForReleases({
      client,
      releases: currentReleases,
      pageLimit: Number(elements.pageLimitInput.value),
      minimumRating: Number(elements.ratingInput.value),
      onProgress: ({ release, releaseIndex, releaseCount, page, totalPages }) => {
        setStatus(
          `Scanning ${releaseIndex + 1}/${releaseCount}: ${release.displayTitle}, page ${page}/${totalPages}.`
        );
      }
    });

    renderSellers(searchResult.sellers, currentReleases, searchResult.warnings);
    const completeCount = searchResult.sellers.filter((seller) => seller.isComplete).length;
    setStatus(
      completeCount
        ? `Found ${completeCount} complete seller ${completeCount === 1 ? "match" : "matches"}.`
        : "No complete seller found in the scanned pages."
    );
  } catch (error) {
    renderError(error);
  } finally {
    setBusy(false);
  }
}

async function loadReleases(items, client) {
  const releases = [];
  const releaseIds = new Set();

  for (const [index, item] of items.entries()) {
    setStatus(`Loading item ${index + 1}/${items.length}.`);

    const resolved = await resolveRequestedItem(item, client);
    updateRate(resolved.rate);

    if (!releaseIds.has(resolved.release.id)) {
      releaseIds.add(resolved.release.id);
      releases.push(resolved.release);
      renderReleases(releases);
    }
  }

  return releases;
}

function renderReleases(releases) {
  elements.releaseList.className = "release-list";
  elements.releaseSummary.textContent = `${releases.length} ${releases.length === 1 ? "item" : "items"}`;

  if (!releases.length) {
    renderNotice(elements.releaseList, "Add release, marketplace release, master, or listing links.");
    elements.releaseSummary.textContent = "No items loaded";
    return;
  }

  elements.releaseList.replaceChildren(
    ...releases.map((release) => {
      const card = document.createElement("article");
      card.className = "release-card";

      const image = document.createElement("img");
      image.className = "release-art";
      image.alt = "";
      image.loading = "lazy";
      image.src = release.image || placeholderCover(release.id);

      const body = document.createElement("div");
      body.className = "release-meta";

      const title = document.createElement("h3");
      title.textContent = release.displayTitle;

      const meta = document.createElement("p");
      meta.textContent = [
        release.year,
        release.country,
        release.format,
        `${release.numForSale} for sale`,
        release.lowestPrice ? `from ${formatMoney(release.lowestPrice)}` : ""
      ]
        .filter(Boolean)
        .join(" / ");

      const actions = document.createElement("div");
      actions.className = "release-actions";
      actions.append(
        textLink(release.uri, "Discogs release"),
        textLink(`https://www.discogs.com/sell/release/${release.id}`, "Marketplace")
      );

      if (release.resolvedFrom) {
        const resolved = document.createElement("p");
        resolved.textContent = `Resolved from ${release.resolvedFrom}`;
        body.append(title, meta, resolved, actions);
      } else {
        body.append(title, meta, actions);
      }

      card.append(image, body);
      return card;
    })
  );
}

function renderSellers(sellers, releases, warnings = []) {
  const topSellers = sellers.filter((seller) => seller.matchedCount > 0).slice(0, 12);
  const completeCount = topSellers.filter((seller) => seller.isComplete).length;

  elements.sellerSummary.textContent = topSellers.length
    ? `${completeCount} complete, ${topSellers.length} shown`
    : "No matches";

  if (!topSellers.length) {
    renderNotice(elements.sellerList, "No sellers matched the requested releases in the scanned pages.");
    return;
  }

  elements.sellerList.className = "seller-list";
  const nodes = [];

  if (warnings.length) {
    const warning = document.createElement("div");
    warning.className = "notice";
    warning.textContent = warnings.join(" ");
    nodes.push(warning);
  }

  nodes.push(
    ...topSellers.map((seller) => {
      const card = document.createElement("article");
      card.className = "seller-card";

      const head = document.createElement("div");
      head.className = "seller-head";

      const titleWrap = document.createElement("div");
      const title = document.createElement("h3");
      const sellerAnchor = document.createElement("a");
      sellerAnchor.href = seller.url;
      sellerAnchor.target = "_blank";
      sellerAnchor.rel = "noreferrer";
      sellerAnchor.textContent = seller.username;
      title.append(sellerAnchor);

      const meta = document.createElement("p");
      meta.className = "seller-meta";
      meta.textContent = [
        `${seller.rating.toFixed(1)}% rating`,
        seller.isComplete ? `item subtotal ${formatMoney(seller.subtotal, seller.listings[0]?.price.currency)}` : ""
      ]
        .filter(Boolean)
        .join(" / ");

      titleWrap.append(title, meta);

      const badge = document.createElement("span");
      badge.className = `match-badge${seller.isComplete ? "" : " partial"}`;
      badge.textContent = `${seller.matchedCount}/${releases.length}`;

      head.append(titleWrap, badge);

      const table = document.createElement("div");
      table.className = "listing-table";

      for (const release of releases) {
        const listing = seller.listingsByRelease.get(release.id);
        table.append(renderListingRow(release, listing));
      }

      card.append(head, table);
      return card;
    })
  );

  elements.sellerList.replaceChildren(...nodes);
}

function renderListingRow(release, listing) {
  const row = document.createElement("div");
  row.className = "listing-row";

  const body = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = release.displayTitle;

  const meta = document.createElement("p");
  meta.textContent = listing
    ? [listing.condition, listing.sleeveCondition ? `Sleeve: ${listing.sleeveCondition}` : ""]
        .filter(Boolean)
        .join(" / ")
    : "No matching listing found";

  body.append(title, meta);

  const side = listing
    ? textLink(listing.uri, listing.price.display, "price")
    : document.createElement("span");

  if (!listing) {
    side.className = "price";
    side.textContent = "Missing";
  }

  row.append(body, side);
  return row;
}

function renderNotice(container, message) {
  container.className = container.id === "seller-list" ? "seller-list empty-state" : "release-list empty-state";
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  container.replaceChildren(paragraph);
}

function renderError(error) {
  const message = formatError(error);
  setStatus(message);
  elements.sellerSummary.textContent = "Error";

  const card = document.createElement("div");
  card.className = "notice error-card";
  card.textContent = message;
  elements.sellerList.className = "seller-list";
  elements.sellerList.replaceChildren(card);
}

function formatError(error) {
  if (error instanceof DiscogsApiError && error.status === 401) {
    return "Discogs rejected the token. Check the personal access token and scan again.";
  }

  if (error instanceof DiscogsApiError && /authenticate/i.test(error.message)) {
    return "Discogs marketplace search requires a personal access token.";
  }

  return error?.message || "Something went wrong while searching Discogs.";
}

function updateItemCount() {
  const count = parseDiscogsItems(elements.itemInput.value).filter((item) => item.type !== "unknown").length;
  elements.itemCount.textContent = `${count} ${count === 1 ? "item" : "items"}`;
}

function setBusy(isBusy) {
  elements.scanButton.disabled = isBusy;
  elements.sampleButton.disabled = isBusy;
  elements.clearButton.disabled = isBusy;
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

function updateRate(rate) {
  if (!rate?.remaining || !rate?.limit) {
    return;
  }

  elements.rateText.textContent = `${rate.remaining}/${rate.limit} API calls left`;
}

function resetApp() {
  elements.form.reset();
  elements.pageLimitInput.value = "5";
  elements.ratingInput.value = "0";
  currentReleases = [];
  updateItemCount();
  setStatus("Ready for Discogs links.");
  elements.rateText.textContent = "";
  elements.releaseSummary.textContent = "No items loaded";
  elements.sellerSummary.textContent = "No scan yet";
  renderNotice(elements.releaseList, "Add release, marketplace release, master, or listing links.");
  renderNotice(elements.sellerList, "Complete sellers appear first, followed by the closest partial matches.");
}

function textLink(href, label, className = "text-link") {
  const anchor = document.createElement("a");
  anchor.className = className;
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  anchor.textContent = label;
  return anchor;
}

function placeholderCover(seed) {
  const hue = Number(seed) % 360;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
      <rect width="120" height="120" fill="hsl(${hue} 36% 78%)"/>
      <circle cx="60" cy="60" r="36" fill="hsl(${(hue + 40) % 360} 32% 30%)"/>
      <circle cx="60" cy="60" r="10" fill="hsl(${hue} 36% 78%)"/>
    </svg>
  `;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
