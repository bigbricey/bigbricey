function legacyTrackerKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Remove dashboard tracker definitions without ever broadening a native id. */
export function removeDashboardTrackers(
  trackers,
  { selector = "", exactIdOnly = false } = {}
) {
  const source = Array.isArray(trackers) ? trackers : [];
  const exactId = String(selector || "").trim();
  const key = legacyTrackerKey(selector);
  if (!exactId) {
    return { trackers: source, removedCount: 0, ambiguous: false };
  }

  if (exactIdOnly) {
    const exactMatches = source.filter(
      (tracker) => String(tracker?.id || "").trim() === exactId
    );
    if (exactMatches.length !== 1) {
      return {
        trackers: source,
        removedCount: 0,
        ambiguous: exactMatches.length > 1,
      };
    }
  }

  const kept = source.filter((tracker) => {
    const id = String(tracker?.id || "").trim();
    if (exactIdOnly) return id !== exactId;

    const normalizedId = id.toLowerCase();
    const measureId = String(tracker?.measure_id || "").toLowerCase();
    const title = legacyTrackerKey(tracker?.title);
    return (
      normalizedId !== key &&
      measureId !== key &&
      title !== key &&
      normalizedId !== `c_${key}` &&
      !title.includes(key)
    );
  });

  return {
    trackers: kept,
    removedCount: source.length - kept.length,
    ambiguous: false,
  };
}
