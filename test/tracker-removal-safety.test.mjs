import assert from "node:assert/strict";
import test from "node:test";

import { removeDashboardTrackers } from "../api/_tracker_mutation.js";

const trackers = [
  {
    id: "c_weight_30d",
    title: "Weight (30-Day)",
    measure_id: "weight_lb",
  },
  {
    id: "c_weight_goal",
    title: "c_weight_30d progress",
    measure_id: "c_weight_30d",
  },
  {
    id: "c_steps",
    title: "Steps",
    measure_id: "steps",
  },
];

test("native tracker removal deletes only the exact confirmed id", () => {
  const result = removeDashboardTrackers(trackers, {
    selector: "c_weight_30d",
    exactIdOnly: true,
  });

  assert.equal(result.removedCount, 1);
  assert.deepEqual(
    result.trackers.map((tracker) => tracker.id),
    ["c_weight_goal", "c_steps"]
  );
});

test("an absent exact id removes nothing even when another title contains it", () => {
  const result = removeDashboardTrackers(trackers, {
    selector: "c_missing",
    exactIdOnly: true,
  });

  assert.equal(result.removedCount, 0);
  assert.deepEqual(result.trackers, trackers);
});

test("duplicate exact ids fail closed instead of deleting multiple panels", () => {
  const duplicated = [trackers[0], { ...trackers[0], title: "Duplicate" }];
  const result = removeDashboardTrackers(duplicated, {
    selector: "c_weight_30d",
    exactIdOnly: true,
  });

  assert.equal(result.removedCount, 0);
  assert.equal(result.ambiguous, true);
  assert.deepEqual(result.trackers, duplicated);
});
