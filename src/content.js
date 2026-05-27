(function () {
  const BUTTON_ID = "dsl-add-release-button";

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "DSL_GET_CURRENT_RELEASE") {
      sendResponse({ release: getCurrentTarget() });
    }
  });

  const release = getCurrentTarget();

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
      const exists = stack.some((item) => getTargetKey(item) === getTargetKey(release));

      if (!exists) {
        await chrome.storage.local.set({ stack: [...stack, release] });
      }

      showToast(exists ? "Already in Seller Locator" : "Added to Seller Locator");
    });

    document.body.append(button);
  }

  function getTargetKey(target) {
    return `${target?.type === "master" ? "master" : "release"}:${Number(target?.id)}`;
  }

  function getCurrentTarget() {
    const target = parseTarget(location.href);

    if (!target) {
      return null;
    }

    return {
      ...target,
      title: getReleaseTitle(target),
      url: `https://www.discogs.com/${target.type}/${target.id}`
    };
  }

  function parseTarget(value) {
    try {
      const url = new URL(value);
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
      const match = String(idSource ?? "").match(/^(\d+)/);
      const id = match ? Number(match[1]) : 0;
      return id ? { type, id } : null;
    } catch {
      return null;
    }
  }

  function getReleaseTitle(target) {
    const title =
      document.querySelector("h1")?.textContent ||
      document.querySelector('meta[property="og:title"]')?.content ||
      document.title ||
      "";

    return title
      .replace(/\s*\|\s*Discogs\s*$/i, "")
      .replace(/^Release\s+["']?/, "")
      .trim() || `Discogs ${target.type} ${target.id}`;
  }

  function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "dsl-toast";
    toast.textContent = message;
    document.body.append(toast);
    window.setTimeout(() => toast.remove(), 1800);
  }
})();
