(function attachHealthSnapshot(root) {
  "use strict";

  let documentData = null;
  let savedSnapshotId = null;

  function node(id) {
    return document.getElementById(id);
  }

  function setStatus(message, error = false) {
    const status = node("snapshotStatus");
    if (!status) return;
    status.textContent = String(message || "");
    status.classList.toggle("is-error", Boolean(error));
  }

  function setBusy(busy) {
    document
      .querySelectorAll("#healthSnapshot button, #healthSnapshot select")
      .forEach((control) => {
        control.disabled = Boolean(busy);
      });
  }

  function summaryCard(label, value, note) {
    const card = document.createElement("div");
    card.className = "snapshot-summary-card";
    const small = document.createElement("span");
    small.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = value;
    const detail = document.createElement("small");
    detail.textContent = note;
    card.append(small, strong, detail);
    return card;
  }

  function renderSummary(data) {
    const summary = node("snapshotSummary");
    if (!summary) return;
    summary.replaceChildren();
    const completeness = data?.completeness || {};
    const quality = data?.data_quality || {};
    const activity = data?.activity_patterns || {};
    const changes = Array.isArray(data?.observed_changes)
      ? data.observed_changes.length
      : 0;
    summary.append(
      summaryCard(
        "Record coverage",
        `${completeness.completeness_percent || 0}%`,
        `${completeness.days_with_any_data || 0} logged · ${completeness.missing_days || 0} missing days`
      ),
      summaryCard(
        "Food confidence",
        String(quality.verified_or_user_confirmed_entries || 0),
        `${quality.estimated_or_unclassified_entries || 0} estimated or unclassified entries`
      ),
      summaryCard(
        "Activity",
        String(activity.sessions || 0),
        `sessions across ${activity.days || 0} days`
      ),
      summaryCard(
        "Recorded changes",
        String(changes),
        "observed trends, not diagnoses"
      )
    );
  }

  async function generate() {
    const period = node("snapshotPeriod")?.value || "10w";
    setBusy(true);
    setStatus("Building your private snapshot…");
    savedSnapshotId = null;
    try {
      const response = await fetch(
        `/api/snapshots?period=${encodeURIComponent(period)}`
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message || "The snapshot could not be built.");
      }
      documentData = data.document;
      const editor = node("snapshotEditor");
      if (editor) editor.value = data.report_text || "";
      renderSummary(documentData);
      const preview = node("snapshotPreview");
      if (preview) preview.hidden = false;
      setStatus("Ready. Review or edit it before saving, printing, or downloading.");
      editor?.focus();
    } catch (error) {
      documentData = null;
      const preview = node("snapshotPreview");
      if (preview) preview.hidden = true;
      setStatus(error.message || "The snapshot could not be built.", true);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!documentData) {
      setStatus("Build a snapshot first.", true);
      return;
    }
    const reportText = node("snapshotEditor")?.value || "";
    const title = node("snapshotDraftTitle")?.value || "Health Snapshot";
    setBusy(true);
    setStatus("Saving private draft…");
    try {
      const update = Boolean(savedSnapshotId);
      const response = await fetch("/api/snapshots", {
        method: update ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          update
            ? { id: savedSnapshotId, title, report_text: reportText }
            : {
                op: "save",
                period: documentData.period?.key || "10w",
                title,
                report_text: reportText,
              }
        ),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message || "The private draft could not be saved.");
      }
      savedSnapshotId = data.snapshot?.id || savedSnapshotId;
      setStatus("Private draft saved. Nothing was shared.");
    } catch (error) {
      setStatus(error.message || "The private draft could not be saved.", true);
    } finally {
      setBusy(false);
    }
  }

  function safeFileTitle(extension) {
    const title = String(node("snapshotDraftTitle")?.value || "health-snapshot")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return `${title || "health-snapshot"}.${extension}`;
  }

  function download(content, type, filename) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function downloadText() {
    const text = node("snapshotEditor")?.value || "";
    if (!documentData || !text) return setStatus("Build a snapshot first.", true);
    download(text, "text/plain;charset=utf-8", safeFileTitle("txt"));
    setStatus("Report downloaded. Nothing was sent anywhere.");
  }

  function downloadJson() {
    if (!documentData) return setStatus("Build a snapshot first.", true);
    const payload = {
      ...documentData,
      user_edited_report_text: node("snapshotEditor")?.value || "",
    };
    download(
      JSON.stringify(payload, null, 2),
      "application/json;charset=utf-8",
      safeFileTitle("json")
    );
    setStatus("Structured data downloaded. Nothing was sent anywhere.");
  }

  function printReport() {
    const text = node("snapshotEditor")?.value || "";
    if (!documentData || !text) return setStatus("Build a snapshot first.", true);
    const popup = root.open("", "_blank");
    if (!popup) {
      setStatus("Allow the print window, then try again.", true);
      return;
    }
    try {
      popup.opener = null;
    } catch {
      /* the new window remains same-origin and contains only local report text */
    }
    const style = popup.document.createElement("style");
    style.textContent =
      "body{font-family:system-ui,-apple-system,sans-serif;max-width:850px;margin:32px auto;padding:0 24px;color:#111}h1{font-size:24px}pre{font:14px/1.55 system-ui,-apple-system,sans-serif;white-space:pre-wrap}small{color:#555}@media print{body{margin:0;max-width:none}}";
    const title = popup.document.createElement("h1");
    title.textContent = node("snapshotDraftTitle")?.value || "Health Snapshot";
    const note = popup.document.createElement("small");
    note.textContent = "User-controlled BigBricey data summary · not medical advice";
    const report = popup.document.createElement("pre");
    report.textContent = text;
    popup.document.head.appendChild(style);
    popup.document.body.append(title, note, report);
    popup.document.title = title.textContent;
    popup.focus();
    popup.print();
    setStatus("Print view opened. Nothing was sent anywhere.");
  }

  function init() {
    node("snapshotGenerate")?.addEventListener("click", generate);
    node("snapshotSave")?.addEventListener("click", save);
    node("snapshotPrint")?.addEventListener("click", printReport);
    node("snapshotDownloadText")?.addEventListener("click", downloadText);
    node("snapshotDownloadJson")?.addEventListener("click", downloadJson);
    node("snapshotPeriod")?.addEventListener("change", () => {
      savedSnapshotId = null;
      setStatus("Choose Build my snapshot to refresh this period.");
    });
  }

  init();
  root.BBHealthSnapshot = Object.freeze({ generate });
})(typeof window !== "undefined" ? window : globalThis);
