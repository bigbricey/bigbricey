import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizeFoodCorrectionKey,
  usualPortionCorrectionFromUpdate,
} from "../api/_food_corrections.js";
import { resolveFood } from "../api/_lib.js";

const brisket = {
  fdcId: 123,
  description: "Beef, brisket, cooked, braised",
  dataType: "Foundation",
  _src: "usda",
  score: 100,
  nutrients: {
    kcal: 291,
    protein: 29,
    fat: 19,
    carbs: 0,
    sodium: 60,
    potassium: 275,
  },
};

test("a confirmed ledger quantity edit becomes a bounded usual-portion correction", () => {
  const correction = usualPortionCorrectionFromUpdate(
    {
      label: "8 oz Beef, brisket, cooked, braised",
      grams: 226.8,
      extras: { provenance: { source_description: brisket.description } },
    },
    {
      label: "1 lb Beef, brisket, cooked, braised",
      grams: 453.6,
      extras: { provenance: { source_description: brisket.description } },
    }
  );
  assert.equal(correction.kind, "usual_portion");
  assert.equal(correction.correctionKey, "beef brisket cooked braised");
  assert.equal(correction.correction.grams, 453.6);
});

test("usual portion is applied only when the user explicitly says usual", async () => {
  const options = {
    parseFoodFn: async () => ({
      parsed: {
        food_query: "brisket",
        amount: 1,
        unit: "serving",
        grams_estimate: null,
      },
    }),
    foodSearchFn: async () => ({ foods: [brisket], errors: [] }),
    foodCorrections: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        correction_key: "beef brisket cooked braised",
        kind: "usual_portion",
        correction: { food_query: brisket.description, grams: 453.6 },
        confirmations: 2,
        active: true,
      },
    ],
  };

  const usual = await resolveFood("log my usual brisket", options);
  assert.equal(usual.row.grams, 453.6);
  assert.equal(
    usual.row.extras.provenance.portion_source,
    "user_confirmed_usual"
  );
  assert.equal(usual.learned_correction.confirmations, 2);

  const vague = await resolveFood("brisket", options);
  assert.equal(vague.row, null);
  assert.match(vague.note, /couldn't verify the weight/i);
});

test("correction keys remove quantities without confusing the food identity", () => {
  assert.equal(
    normalizeFoodCorrectionKey("1 lb Beef, brisket, cooked, braised"),
    "beef brisket cooked braised"
  );
});

test("correction persistence is account scoped and only runs after ledger commit", async () => {
  const supabase = await readFile(new URL("../api/_supabase.js", import.meta.url), "utf8");
  const chat = await readFile(new URL("../api/chat.js", import.meta.url), "utf8");
  assert.match(supabase, /account_id: `eq\.\$\{accountId\}`/);
  assert.match(supabase, /record_food_correction/);
  assert.ok(
    chat.indexOf("ledgerCommitted = true") <
      chat.indexOf("pendingFoodCorrections.map")
  );
});
