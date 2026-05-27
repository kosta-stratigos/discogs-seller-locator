(function () {
  const BUTTON_ID = "dsl-add-release-button";

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "DSL_GET_CURRENT_RELEASE") {
      sendResponse({ release: getCurrentRelease() });
    }
  });

  const release = getCurrentRelease();

  if (release) {
    installAddButton(release);
  }

  function installAddButton(release) {
    if (document.getElementById(BUTTON_ID)) {
      return;
    }

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = "Add to Seller Locator";
    button.addEventListener("click", async () => {
      const saved = await chrome.storage.local.get({ stack: [] });
      const stack = Array.isArray(saved.stack) ? saved.stack : [];
      const exists = stack.some((item) => item.id === release.id);

      if (!exists) {
        await chrome.storage.local.set({ stack: [...stack, release] });
      }

      showToast(exists ? "Already in Seller Locator" : "Added to Seller Locator");
    });

    document.body.append(button);
  }

  function getCurrentRelease() {
    const id = parseReleaseId(location.href);

    if (!id) {
      return null;
    }

    return {
      id,
      title: getReleaseTitle(id),
      url: `https://www.discogs.com/release/${id}`
    };
  }

  function parseReleaseId(value) {
    try {
      const url = new URL(value);
      const parts = url.pathname.split("/").filter(Boolean);
      const releaseIndex = parts.indexOf("release");
      const sellReleaseIndex = parts[0] === "sell" && parts[1] === "release" ? 1 : -1;
      const idSource = releaseIndex >= 0 ? parts[releaseIndex + 1] : parts[sellReleaseIndex + 1];
      const match = String(idSource ?? "").match(/^(\d+)/);
      return match ? Number(match[1]) : 0;
    } catch {
      return 0;
    }
  }

  function getReleaseTitle(id) {
    const title =
      document.querySelector("h1")?.textContent ||
      document.querySelector('meta[property="og:title"]')?.content ||
      document.title ||
      "";

    return title
      .replace(/\s*\|\s*Discogs\s*$/i, "")
      .replace(/^Release\s+["']?/, "")
      .trim() || `Discogs release ${id}`;
  }

  function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "dsl-toast";
    toast.textContent = message;
    document.body.append(toast);
    window.setTimeout(() => toast.remove(), 1800);
  }
})();
