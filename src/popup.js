import {
  formatMoney,
  parseDiscogsTargetUrl,
  scanMarketplaceForReleases
} from "./scanner.js";

const elements = {
  addCurrentButton: document.querySelector("#add-current-button"),
  scanButton: document.querySelector("#scan-button"),
  manualReleaseInput: document.querySelector("#manual-release-input"),
  manualAddButton: document.querySelector("#manual-add-button"),
  clearStackButton: document.querySelector("#clear-stack-button"),
  stackCount: document.querySelector("#stack-count"),
  stackList: document.querySelector("#stack-list"),
  pageLimitInput: document.querySelector("#page-limit-input"),
  versionLimitInput: document.querySelector("#version-limit-input"),
  minimumRatingInput: document.querySelector("#minimum-rating-input"),
  shipsFromInput: document.querySelector("#ships-from-input"),
  maximumPriceInput: document.querySelector("#maximum-price-input"),
  resultSummary: document.querySelector("#result-summary"),
  statusText: document.querySelector("#status-text"),
  resultList: document.querySelector("#result-list")
};

let stack = [];
let isScanning = false;

elements.addCurrentButton.addEventListener("click", addCurrentRelease);
elements.manualAddButton.addEventListener("click", addManualRelease);
elements.manualReleaseInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    addManualRelease();
  }
});
elements.clearStackButton.addEventListener("click", clearStack);
elements.scanButton.addEventListener("click", scanStack);

await loadStack();

async function addCurrentRelease() {
  setStatus("Reading current Discogs page.");

  try {
    const release = await getCurrentRelease();

    if (!release) {
      setStatus("Open a Discogs release or master page, then try again.");
      return;
    }

    await addRelease(release);
    setStatus(`Added ${release.title}.`);
  } catch (error) {
    setStatus(error.message || "Could not read the current tab.");
  }
}

async function addManualRelease() {
  const release = parseDiscogsTargetUrl(elements.manualReleaseInput.value);

  if (!release) {
    setStatus("Paste a Discogs release or master URL.");
    return;
  }

  await addRelease(release);
  elements.manualReleaseInput.value = "";
  setStatus(`Added ${release.title}.`);
}

async function addRelease(release) {
  const target = normalizeTarget(release);
  const exists = stack.some((item) => getTargetKey(item) === target.key);

  if (!exists) {
    stack = [...stack, target];
    await saveStack();
    renderStack();
  }
}

async function removeRelease(key) {
  stack = stack.filter((release) => getTargetKey(release) !== key);
  await saveStack();
  renderStack();
}

async function clearStack() {
  stack = [];
  await saveStack();
  renderStack();
  setStatus("Stack cleared.");
}

async function scanStack() {
  if (!stack.length || isScanning) {
    return;
  }

  setBusy(true);
  elements.resultSummary.textContent = "Scanning";
  renderResults([]);
  setStatus("Starting marketplace scan.");

  try {
    const result = await scanMarketplaceForReleases({
      releases: stack,
      pageLimit: Number(elements.pageLimitInput.value),
      versionLimit: Number(elements.versionLimitInput.value),
      filters: {
        minimumRating: elements.minimumRatingInput.value,
        shipsFrom: elements.shipsFromInput.value,
        maximumPrice: elements.maximumPriceInput.value
      },
      fetchJson: async (url) => {
        const response = await fetch(url, {
          credentials: "include",
          headers: {
            Accept: "application/vnd.discogs.v2.discogs+json"
          }
        });

        if (!response.ok) {
          throw new Error(`Discogs returned ${response.status} while loading master versions.`);
        }

        return response.json();
      },
      fetchPage: async (url) => {
        const response = await fetch(url, {
          credentials: "include",
          headers: {
            Accept: "text/html"
          }
        });

        if (!response.ok) {
          throw new Error(`Discogs returned ${response.status} while scanning marketplace pages.`);
        }

        return response.text();
      },
      onProgress: ({ target, candidate, targetIndex, targetCount, candidateIndex, candidateCount, page, totalPages }) => {
        const versionText = target.type === "master"
          ? ` version ${candidateIndex + 1}/${candidateCount}`
          : "";
        setStatus(
          `Scanning ${targetIndex + 1}/${targetCount}: ${target.title}${versionText}, page ${page}/${totalPages}.`
        );
      }
    });

    renderResults(result.sellers, result.warnings);
    const completeCount = result.sellers.filter((seller) => seller.isComplete).length;
    elements.resultSummary.textContent = completeCount
      ? `${completeCount} complete`
      : "No complete match";
    setStatus(
      completeCount
        ? `Found ${completeCount} complete seller ${completeCount === 1 ? "match" : "matches"}.`
        : "No single seller was found in the scanned pages."
    );
  } catch (error) {
    renderWarning(error.message || "Something went wrong while scanning Discogs.");
    elements.resultSummary.textContent = "Error";
    setStatus("Scan stopped.");
  } finally {
    setBusy(false);
  }
}

function renderStack() {
  elements.stackCount.textContent = String(stack.length);
  elements.scanButton.disabled = isScanning || !stack.length;

  if (!stack.length) {
    elements.stackList.className = "stack-list empty-state";
    elements.stackList.textContent = "Add Discogs release or master pages, then scan for sellers who have them all. Masters sweep multiple versions.";
    return;
  }

  elements.stackList.className = "stack-list";
  elements.stackList.replaceChildren(
    ...stack.map((release) => {
      const row = document.createElement("article");
      row.className = "release-row";

      const body = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = release.title;
      const meta = document.createElement("p");
      meta.textContent = `${formatTargetType(release)} ${release.id}`;
      body.append(title, meta);

      const remove = document.createElement("button");
      remove.className = "remove-button";
      remove.type = "button";
      remove.textContent = "x";
      remove.addEventListener("click", () => removeRelease(getTargetKey(release)));

      row.append(body, remove);
      return row;
    })
  );
}

function renderResults(sellers, warnings = []) {
  const matches = sellers.filter((seller) => seller.matchedCount > 0).slice(0, 15);

  if (!matches.length && !warnings.length) {
    elements.resultList.className = "result-list empty-state";
    elements.resultList.textContent = "No sellers matched in the scanned pages.";
    return;
  }

  elements.resultList.className = "result-list";
  const nodes = warnings.map(createWarning);

  nodes.push(
    ...matches.map((seller) => {
      const card = document.createElement("article");
      card.className = "seller-card";

      const head = document.createElement("div");
      head.className = "seller-head";

      const sellerInfo = document.createElement("div");
      const title = document.createElement("h3");
      const sellerLink = document.createElement("a");
      sellerLink.href = seller.url;
      sellerLink.target = "_blank";
      sellerLink.rel = "noreferrer";
      sellerLink.textContent = seller.username;
      title.append(sellerLink);

      const meta = document.createElement("p");
      meta.textContent = [
        Number.isFinite(seller.rating) ? `${seller.rating.toFixed(1)}% rating` : "",
        seller.isComplete ? `subtotal ${formatMoney(seller.subtotal, seller.listings[0]?.price.currency)}` : ""
      ]
        .filter(Boolean)
        .join(" / ");

      sellerInfo.append(title, meta);

      const badge = document.createElement("span");
      badge.className = "match-badge";
      badge.textContent = `${seller.matchedCount}/${stack.length}`;
      head.append(sellerInfo, badge);
      card.append(head);

      for (const target of stack) {
        const listing = seller.listingsByRelease.get(getTargetKey(target));
        card.append(createListingRow(target, listing));
      }

      return card;
    })
  );

  elements.resultList.replaceChildren(...nodes);
}

function createListingRow(release, listing) {
  const row = document.createElement("div");
  row.className = "listing-row";

  const body = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = release.title;
  const meta = document.createElement("p");
  meta.textContent = listing
    ? [
        listing.targetKey?.startsWith("master:") ? `Version: ${listing.releaseTitle}` : "",
        listing.releaseSubtitle,
        listing.condition,
        listing.sleeveCondition,
        listing.shipsFrom ? `Ships from ${listing.shipsFrom}` : ""
      ]
        .filter(Boolean)
        .join(" / ")
    : "Missing";
  body.append(title, meta);

  const side = listing ? document.createElement("a") : document.createElement("span");
  side.className = "price-link";
  side.textContent = listing ? listing.price.display : "Missing";

  if (listing) {
    side.href = listing.uri;
    side.target = "_blank";
    side.rel = "noreferrer";
  }

  row.append(body, side);
  return row;
}

function renderWarning(message) {
  elements.resultList.className = "result-list";
  elements.resultList.replaceChildren(createWarning(message));
}

function createWarning(message) {
  const warning = document.createElement("div");
  warning.className = "empty-state warning";
  warning.textContent = message;
  return warning;
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

function setBusy(nextIsScanning) {
  isScanning = nextIsScanning;
  elements.addCurrentButton.disabled = isScanning;
  elements.manualAddButton.disabled = isScanning;
  elements.clearStackButton.disabled = isScanning;
  elements.scanButton.disabled = isScanning || !stack.length;
}

async function getCurrentRelease() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    return null;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "DSL_GET_CURRENT_RELEASE" });
    return response?.release ?? null;
  } catch {
    return parseDiscogsTargetUrl(tab.url);
  }
}

async function loadStack() {
  const saved = await chrome.storage.local.get({ stack: [] });
  stack = Array.isArray(saved.stack) ? saved.stack : [];
  renderStack();
}

async function saveStack() {
  await chrome.storage.local.set({ stack });
}

function normalizeTarget(target) {
  const type = target?.type === "master" ? "master" : "release";
  const id = Number(target?.id);

  return {
    ...target,
    type,
    id,
    key: target?.key || `${type}:${id}`,
    title: target?.title || `Discogs ${type} ${id}`,
    url: target?.url || `https://www.discogs.com/${type}/${id}`
  };
}

function getTargetKey(target) {
  return target?.key || `${target?.type === "master" ? "master" : "release"}:${Number(target?.id)}`;
}

function formatTargetType(target) {
  return target?.type === "master" ? "Master" : "Release";
}
