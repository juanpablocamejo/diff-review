import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MODELS_CACHE_TTL_MS,
  modelsCachePath,
  readModelsCache,
  writeModelsCache,
} from "./models-cache.mjs";
import { sortModelSelectOptions } from "./model-label.mjs";

test("sortModelSelectOptions: default y auto primero, resto lexico", () => {
  const sorted = sortModelSelectOptions([
    { value: "zulu", label: "Zulu" },
    { value: "auto", label: "Auto" },
    { value: "alpha", label: "Alpha" },
    { value: "", label: "Por defecto" },
    { value: "bravo", label: "Bravo" },
  ]);
  assert.deepEqual(
    sorted.map((o) => o.value),
    ["", "auto", "alpha", "bravo", "zulu"]
  );
});

test("models cache roundtrip + TTL", () => {
  const home = mkdtempSync(join(tmpdir(), "diff-review-mc-"));
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  writeModelsCache(
    "claude",
    {
      models: [{ value: "opus", name: "Opus" }],
      currentModel: "default",
    },
    { home, now }
  );
  assert.ok(readFileSync(modelsCachePath(home), "utf8").includes("opus"));

  const hit = readModelsCache("claude", { home, now: now + 1000 });
  assert.equal(hit?.currentModel, "default");
  assert.equal(hit?.models[0].value, "opus");

  const expired = readModelsCache("claude", {
    home,
    now: now + MODELS_CACHE_TTL_MS + 1,
  });
  assert.equal(expired, null);
});
