(function attachFeedback(root) {
  "use strict";

  let currentKind = "idea";
  let currentInteractionId = null;
  let currentTrustRating = null;
  let returnFocus = null;

  function node(id) {
    return document.getElementById(id);
  }

  function setStatus(message, error = false) {
    const status = node("feedbackStatus");
    if (!status) return;
    status.textContent = String(message || "");
    status.classList.toggle("is-error", Boolean(error));
  }

  function setBusy(busy) {
    node("feedbackSend")?.toggleAttribute("disabled", Boolean(busy));
    node("feedbackCancel")?.toggleAttribute("disabled", Boolean(busy));
  }

  function open({ kind = "idea", interactionId = null, trustRating = null, source } = {}) {
    currentKind = ["wrong", "correction", "idea", "trust"].includes(kind)
      ? kind
      : "idea";
    currentInteractionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(interactionId || ""))
      ? String(interactionId).toLowerCase()
      : null;
    currentTrustRating = Number(trustRating) || null;
    returnFocus = source || document.activeElement;
    const modal = node("feedbackModal");
    const title = node("feedbackModalTitle");
    const intro = node("feedbackModalIntro");
    const message = node("feedbackMessage");
    const contextOption = node("feedbackContextOption");
    const context = node("feedbackIncludeContext");
    const consent = node("feedbackConsent");
    if (title) {
      title.textContent =
        currentKind === "wrong"
          ? "What was wrong?"
          : currentKind === "trust"
            ? `Trust rating: ${currentTrustRating} out of 5`
            : "Help shape BigBricey";
    }
    if (intro) {
      intro.textContent =
        currentKind === "wrong"
          ? "A correction helps the assistant and product get better."
          : currentKind === "trust"
            ? "You can add a note, then confirm before sending."
            : "Send Brice an idea for the founding beta.";
    }
    if (message) message.value = "";
    if (context) context.checked = false;
    if (consent) consent.checked = false;
    if (contextOption) contextOption.hidden = !currentInteractionId;
    setStatus("");
    if (modal) modal.hidden = false;
    message?.focus();
  }

  function close() {
    const modal = node("feedbackModal");
    if (modal) modal.hidden = true;
    setStatus("");
    if (returnFocus && typeof returnFocus.focus === "function") returnFocus.focus();
    returnFocus = null;
  }

  async function send() {
    const consent = node("feedbackConsent")?.checked === true;
    if (!consent) {
      setStatus("Check the consent box before sending.", true);
      node("feedbackConsent")?.focus();
      return;
    }
    const message = node("feedbackMessage")?.value || "";
    const includeContext =
      Boolean(currentInteractionId) &&
      node("feedbackIncludeContext")?.checked === true;
    setBusy(true);
    setStatus("Sending…");
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: currentKind,
          interaction_id: currentInteractionId,
          message,
          category: node("feedbackCategory")?.value || "other",
          include_context: includeContext,
          consent: true,
          trust_rating: currentTrustRating,
          correction:
            ["wrong", "correction"].includes(currentKind) && message.trim()
              ? { field: "assistant_response", note: message }
              : null,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message || "Feedback could not be sent.");
      }
      setStatus(
        includeContext
          ? "Sent with the selected interaction context."
          : "Sent without conversation context."
      );
      setTimeout(close, 650);
    } catch (error) {
      setStatus(error.message || "Feedback could not be sent.", true);
    } finally {
      setBusy(false);
    }
  }

  function createWrongButton(interactionId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(interactionId || ""))) return null;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chat-feedback-button";
    button.textContent = "That was wrong";
    button.setAttribute("aria-label", "Report that this BigBricey response was wrong");
    button.addEventListener("click", () =>
      open({
        kind: "wrong",
        interactionId,
        source: button,
      })
    );
    return button;
  }

  function init() {
    node("feedbackCancel")?.addEventListener("click", close);
    node("feedbackSend")?.addEventListener("click", send);
    node("feedbackIdea")?.addEventListener("click", (event) =>
      open({ kind: "idea", source: event.currentTarget })
    );
    document.querySelectorAll("[data-trust-rating]").forEach((button) => {
      button.addEventListener("click", () =>
        open({
          kind: "trust",
          trustRating: Number(button.dataset.trustRating),
          source: button,
        })
      );
    });
    node("feedbackModal")?.addEventListener("click", (event) => {
      if (event.target === node("feedbackModal")) close();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !node("feedbackModal")?.hidden) close();
    });
  }

  init();
  root.BBFeedback = Object.freeze({ createWrongButton, open });
})(typeof window !== "undefined" ? window : globalThis);
