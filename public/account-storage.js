(function attachAccountStorage(root) {
  "use strict";

  function normalizeAccount(account) {
    const normalized = String(account || "").trim().toLowerCase();
    if (!normalized) throw new Error("account required for local storage");
    return normalized;
  }

  function key(prefix, account) {
    const safePrefix = String(prefix || "");
    if (!/^[a-z0-9_-]+$/i.test(safePrefix)) {
      throw new Error("valid local storage prefix required");
    }
    return safePrefix + encodeURIComponent(normalizeAccount(account));
  }

  /**
   * A legacy global preference cannot safely be attributed to the next account
   * that signs in. Preserve it for manual recovery, then stop reading it.
   */
  function quarantineLegacyKey(storage, legacyKey, quarantineKey) {
    const oldKey = String(legacyKey || "");
    const safeKey = String(quarantineKey || "");
    if (!oldKey || !safeKey) return false;
    const raw = storage.getItem(oldKey);
    if (raw == null) return false;
    if (storage.getItem(safeKey) == null) storage.setItem(safeKey, raw);
    storage.removeItem(oldKey);
    return true;
  }

  root.BBAccountStorage = Object.freeze({
    key,
    normalizeAccount,
    quarantineLegacyKey,
  });
})(typeof window !== "undefined" ? window : globalThis);
