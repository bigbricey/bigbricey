(function attachFoodStorage(root) {
  "use strict";

  const SCOPED_PREFIX = "bigbricey-day-v2-";
  const LEGACY_DAY = /^bigbricey-day-(\d{4}-\d{2}-\d{2})$/;
  const QUARANTINE_PREFIX = "bigbricey-unassigned-day-";

  function accountPart(account) {
    const normalized = String(account || "").trim().toLowerCase();
    if (!normalized) throw new Error("account required for local food storage");
    return encodeURIComponent(normalized);
  }

  function key(account, day) {
    const date = String(day || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("valid day required");
    return `${SCOPED_PREFIX}${accountPart(account)}-${date}`;
  }

  function load(storage, account, day) {
    try {
      const parsed = JSON.parse(storage.getItem(key(account, day)) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function save(storage, account, day, rows) {
    if (!Array.isArray(rows)) throw new Error("rows must be an array");
    storage.setItem(key(account, day), JSON.stringify(rows));
  }

  function createDaySyncSnapshot(day, rows, allowClear, expectedRevision = null) {
    const date = String(day || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("valid day required");
    if (!Array.isArray(rows)) throw new Error("rows must be an array");
    const revision =
      expectedRevision == null || expectedRevision === ""
        ? null
        : Number(expectedRevision);
    return {
      day: date,
      rows: JSON.parse(JSON.stringify(rows)),
      allowClear: allowClear === true,
      ...(revision != null && Number.isInteger(revision) && revision >= 0
        ? { expectedRevision: revision }
        : {}),
    };
  }

  /**
   * Old day-only keys cannot safely be attributed to whichever account happens
   * to sign in next. Preserve them for manual recovery, but never auto-upload.
   */
  function quarantineLegacyDays(storage) {
    const legacyKeys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const candidate = storage.key(index);
      if (candidate && LEGACY_DAY.test(candidate)) legacyKeys.push(candidate);
    }
    for (const legacyKey of legacyKeys) {
      const match = legacyKey.match(LEGACY_DAY);
      const raw = storage.getItem(legacyKey);
      const quarantineKey = QUARANTINE_PREFIX + match[1];
      if (raw != null && storage.getItem(quarantineKey) == null) {
        storage.setItem(quarantineKey, raw);
      }
      storage.removeItem(legacyKey);
    }
    return legacyKeys.length;
  }

  root.BBFoodStorage = Object.freeze({
    key,
    load,
    save,
    quarantineLegacyDays,
    createDaySyncSnapshot,
  });
})(typeof window !== "undefined" ? window : globalThis);
