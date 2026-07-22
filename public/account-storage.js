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

  /**
   * Move already account-scoped browser state from a verified login email key
   * to its new random account-id key. Existing destination values always win.
   */
  function migrateScopedKeys(storage, fromAccount, toAccount, prefixes = []) {
    const from = encodeURIComponent(normalizeAccount(fromAccount));
    const to = encodeURIComponent(normalizeAccount(toAccount));
    if (from === to) return 0;
    const safePrefixes = (Array.isArray(prefixes) ? prefixes : []).filter(
      (prefix) => /^[a-z0-9_-]+$/i.test(String(prefix || ""))
    );
    if (!safePrefixes.length) return 0;
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const candidate = storage.key(index);
      if (candidate) keys.push(candidate);
    }
    let moved = 0;
    for (const sourceKey of keys) {
      const prefix = safePrefixes.find((item) =>
        sourceKey.startsWith(`${item}${from}`)
      );
      if (!prefix) continue;
      const suffix = sourceKey.slice(`${prefix}${from}`.length);
      const destinationKey = `${prefix}${to}${suffix}`;
      const value = storage.getItem(sourceKey);
      if (value != null && storage.getItem(destinationKey) == null) {
        storage.setItem(destinationKey, value);
      }
      storage.removeItem(sourceKey);
      moved += 1;
    }
    return moved;
  }

  root.BBAccountStorage = Object.freeze({
    key,
    normalizeAccount,
    quarantineLegacyKey,
    migrateScopedKeys,
  });
})(typeof window !== "undefined" ? window : globalThis);
