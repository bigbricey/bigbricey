(function attachCompanionSettings(root) {
  "use strict";

  const DISMISS_PREFIX = "bigbricey-suggestion-dismissals-v1-";
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  let settings = null;
  let account = null;

  function accountKey() {
    const value = String(
      account || root.__ntUser?.account_id || root.__ntUser?.email || ""
    )
      .trim()
      .toLowerCase();
    return value ? DISMISS_PREFIX + encodeURIComponent(value) : null;
  }

  function dismissalMap() {
    const key = accountKey();
    if (!key) return {};
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "{}");
      const now = Date.now();
      return Object.fromEntries(
        Object.entries(parsed || {}).filter(
          ([id, at]) =>
            /^[a-z0-9:_-]{1,160}$/i.test(id) &&
            Number.isFinite(Number(at)) &&
            now - Number(at) < WEEK_MS
        )
      );
    } catch {
      return {};
    }
  }

  function dismissSuggestion(id) {
    const key = accountKey();
    if (!key || !/^[a-z0-9:_-]{1,160}$/i.test(String(id || ""))) return;
    const dismissed = dismissalMap();
    dismissed[id] = Date.now();
    localStorage.setItem(key, JSON.stringify(dismissed));
  }

  function setStatus(message, isError) {
    const node = document.getElementById("companionSettingsStatus");
    if (!node) return;
    node.textContent = String(message || "");
    node.classList.toggle("is-error", Boolean(isError));
  }

  function setBusy(busy) {
    document
      .getElementById("companionSettingsForm")
      ?.querySelectorAll("button, input, select")
      .forEach((control) => {
        control.disabled = Boolean(busy);
      });
  }

  function apply(value) {
    if (!value || typeof value !== "object") return;
    settings = value;
    const nickname = document.getElementById("companionNickname");
    const personality = document.getElementById("companionPersonality");
    const detail = document.getElementById("companionDetail");
    const quietEnabled = document.getElementById("companionQuietEnabled");
    const quietStart = document.getElementById("companionQuietStart");
    const quietEnd = document.getElementById("companionQuietEnd");
    if (nickname) nickname.value = value.nickname || "";
    if (personality) personality.value = value.personality || "auto";
    if (detail) detail.value = value.detail || "auto";
    document
      .querySelectorAll('input[name="companionMode"]')
      .forEach((control) => {
        control.checked = control.value === (value.mode || "helpful");
      });
    document.querySelectorAll("[data-companion-category]").forEach((control) => {
      control.checked = value.category_permissions?.[control.dataset.companionCategory] !== false;
    });
    if (quietEnabled) quietEnabled.checked = value.quiet_hours?.enabled === true;
    if (quietStart) quietStart.value = value.quiet_hours?.start || "21:00";
    if (quietEnd) quietEnd.value = value.quiet_hours?.end || "08:00";
  }

  function formPatch() {
    const categories = {};
    document.querySelectorAll("[data-companion-category]").forEach((control) => {
      categories[control.dataset.companionCategory] = control.checked;
    });
    return {
      nickname: document.getElementById("companionNickname")?.value || "",
      mode:
        document.querySelector('input[name="companionMode"]:checked')?.value ||
        "helpful",
      personality: document.getElementById("companionPersonality")?.value || "auto",
      detail: document.getElementById("companionDetail")?.value || "auto",
      category_permissions: categories,
      quiet_hours: {
        enabled: document.getElementById("companionQuietEnabled")?.checked === true,
        start: document.getElementById("companionQuietStart")?.value || "21:00",
        end: document.getElementById("companionQuietEnd")?.value || "08:00",
      },
    };
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setStatus("Saving…", false);
    try {
      const response = await fetch("/api/companion", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: formPatch() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message || "Preferences could not be saved.");
      }
      apply(data.settings);
      root.__ntUser = root.__ntUser || {};
      root.__ntUser.companion_settings = data.settings;
      setStatus("Saved.", false);
    } catch (error) {
      setStatus(error.message || "Preferences could not be saved.", true);
    } finally {
      setBusy(false);
    }
  }

  function init(value, accountId) {
    account = accountId || root.__ntUser?.account_id || root.__ntUser?.email || null;
    apply(value || {});
    const form = document.getElementById("companionSettingsForm");
    if (form && form.dataset.wired !== "true") {
      form.dataset.wired = "true";
      form.addEventListener("submit", save);
    }
  }

  function renderSuggestionBanner(banner, suggestions) {
    if (!banner) return;
    const dismissed = dismissalMap();
    const suggestion = (Array.isArray(suggestions) ? suggestions : []).find(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.message === "string" &&
        !dismissed[item.id]
    );
    banner.replaceChildren();
    if (!suggestion) {
      banner.hidden = true;
      return;
    }
    const message = document.createElement("span");
    message.textContent = suggestion.message;
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "alert-banner-dismiss";
    dismiss.textContent = "Dismiss";
    dismiss.setAttribute("aria-label", "Dismiss this BigBricey suggestion for seven days");
    dismiss.addEventListener("click", () => {
      dismissSuggestion(suggestion.id);
      banner.hidden = true;
      banner.replaceChildren();
    });
    banner.append(message, dismiss);
    banner.hidden = false;
  }

  root.BBCompanion = Object.freeze({
    init,
    apply,
    renderSuggestionBanner,
    get settings() {
      return settings;
    },
  });
})(typeof window !== "undefined" ? window : globalThis);
