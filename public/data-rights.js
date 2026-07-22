(function attachDataRights(root) {
  "use strict";

  function node(id) {
    return document.getElementById(id);
  }

  function setStatus(message, error = false) {
    const status = node("dataRightsStatus");
    if (!status) return;
    status.textContent = String(message || "");
    status.classList.toggle("is-error", Boolean(error));
  }

  function setBusy(busy) {
    document.querySelectorAll("#dataRights button, #dataRights input").forEach((item) => {
      item.disabled = Boolean(busy);
    });
  }

  async function request(operation, extra = {}) {
    setBusy(true);
    setStatus("Recording your request…");
    try {
      const response = await fetch("/api/data-rights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: operation, ...extra }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message || "The request could not be recorded.");
      }
      setStatus(data.message || "Request recorded.");
      if (operation === "request_deletion") {
        const panel = node("deletionRequestPanel");
        if (panel) panel.hidden = true;
      }
    } catch (error) {
      setStatus(error.message || "The request could not be recorded.", true);
    } finally {
      setBusy(false);
    }
  }

  function init() {
    node("requestFullExport")?.addEventListener("click", () =>
      request("request_export")
    );
    node("showDeletionRequest")?.addEventListener("click", () => {
      const panel = node("deletionRequestPanel");
      if (panel) panel.hidden = false;
      node("deletionConfirmation")?.focus();
    });
    node("cancelDeletionRequest")?.addEventListener("click", () => {
      const panel = node("deletionRequestPanel");
      if (panel) panel.hidden = true;
      const input = node("deletionConfirmation");
      if (input) input.value = "";
      setStatus("");
    });
    node("submitDeletionRequest")?.addEventListener("click", () =>
      request("request_deletion", {
        confirmation: node("deletionConfirmation")?.value || "",
      })
    );
  }

  init();
  root.BBDataRights = Object.freeze({ request });
})(typeof window !== "undefined" ? window : globalThis);
