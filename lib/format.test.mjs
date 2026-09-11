import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDurationMs, formatTimings, normalizeMs } from "./format.mjs";

test("formatDurationMs covers seconds, minutes and hours", () => {
  assert.equal(formatDurationMs(-1), "");
  assert.equal(formatDurationMs(undefined), "");
  assert.equal(formatDurationMs(0), "<1 s");
  assert.equal(formatDurationMs(999), "<1 s");
  assert.equal(formatDurationMs(1000), "1 s");
  assert.equal(formatDurationMs(59_000), "59 s");
  assert.equal(formatDurationMs(60_000), "1 min");
  assert.equal(formatDurationMs(61_000), "1 min 1 s");
  assert.equal(formatDurationMs(3_600_000), "1 h");
  assert.equal(formatDurationMs(3_660_000), "1 h 1 min");
});

test("formatTimings lists pipeline phases", () => {
  assert.equal(formatTimings(null), "");
  assert.equal(
    formatTimings({ extractMs: 1200, aiMs: 65_000, renderMs: 400 }),
    "git 1 s · modelo 1 min 5 s · HTML <1 s",
  );
});

test("normalizeMs rejects junk", () => {
  assert.equal(normalizeMs(12.4), 12);
  assert.equal(normalizeMs("80"), 80);
  assert.equal(normalizeMs(-3), null);
  assert.equal(normalizeMs("nope"), null);
});
