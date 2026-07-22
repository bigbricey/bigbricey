(function attachProductEvents(root) {
  "use strict";

  const ALLOWED = new Set([
    "app_opened",
    "chat_response_completed",
    "log_completed",
    "clarification_received",
    "false_success_prevented",
    "chart_created",
    "photo_review_opened",
    "photo_log_confirmed",
  ]);

  function record(eventName, options = {}) {
    if (!ALLOWED.has(eventName)) return Promise.resolve(false);
    return fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        event_name: eventName,
        duration_ms: options.duration_ms ?? null,
        numeric_value: options.numeric_value ?? null,
        metadata:
          options.metadata && typeof options.metadata === "object"
            ? options.metadata
            : {},
      }),
    })
      .then((response) => response.ok)
      .catch(() => false);
  }

  root.BBProductEvents = Object.freeze({ record });
})(typeof window !== "undefined" ? window : globalThis);
