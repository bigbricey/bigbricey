import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const apiRoot = new URL("../api/", import.meta.url);

async function publicFunctions(directory = apiRoot, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith("_")) continue;
    if (entry.isDirectory()) {
      files.push(
        ...(await publicFunctions(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`))
      );
    } else if (entry.name.endsWith(".js")) {
      files.push(`${prefix}${entry.name}`);
    }
  }
  return files;
}

test("production API stays inside the Vercel Hobby function budget", async () => {
  const functions = await publicFunctions();
  assert.ok(
    functions.length <= 12,
    `Expected at most 12 public functions, found ${functions.length}: ${functions.join(", ")}`
  );
  assert.ok(functions.includes("account.js"));
});

test("consolidated account routes preserve their public URLs", async () => {
  const config = JSON.parse(
    await readFile(new URL("../vercel.json", import.meta.url), "utf8")
  );
  const expected = [
    "companion",
    "data-rights",
    "feedback",
    "health",
    "records",
    "snapshots",
  ];
  for (const route of expected) {
    assert.ok(
      config.rewrites.some(
        (rewrite) =>
          rewrite.source === `/api/${route}` &&
          rewrite.destination === `/api/account?__account_route=${route}`
      ),
      `Missing consolidated rewrite for ${route}`
    );
  }
});
