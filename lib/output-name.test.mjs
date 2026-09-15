import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatOutputStamp,
  isOutputFilename,
  makeOutputFilename,
  OUTPUT_FILENAME_LEGACY,
} from "./output-name.mjs";

describe("output-name", () => {
  const when = new Date(2026, 8, 15, 14, 30, 45);
  const stamp = "20260915-143045";

  it("formats stamp", () => {
    assert.equal(formatOutputStamp(when), stamp);
  });

  it("builds name with short tip hashes", () => {
    const name = makeOutputFilename({
      branchSha: "aaaaaaaaaa1111111111",
      baseSha: "bbbbbbbbbb2222222222",
      when,
    });
    assert.equal(name, "diff-report_aaaaaaaaaa-bbbbbbbbbb_20260915-143045.json");
    assert.equal(isOutputFilename(name), true);
  });

  it("reuses an explicit stamp", () => {
    const name = makeOutputFilename({
      branchSha: "abcdef0123456789",
      baseSha: "fedcba9876543210",
      stamp: "20260101-000000",
    });
    assert.equal(name, "diff-report_abcdef0123-fedcba9876_20260101-000000.json");
  });

  it("falls back to legacy stamp without tips", () => {
    const name = makeOutputFilename({ when });
    assert.equal(name, "diff-review-output-20260915-143045.json");
    assert.equal(isOutputFilename(name), true);
  });

  it("accepts legacy names", () => {
    assert.equal(OUTPUT_FILENAME_LEGACY, "diff-review-output.json");
    assert.equal(isOutputFilename(OUTPUT_FILENAME_LEGACY), true);
    assert.equal(isOutputFilename("diff-review-output-20260915-143045.json"), true);
  });

  it("rejects other names", () => {
    assert.equal(isOutputFilename("review.json"), false);
    assert.equal(isOutputFilename("diff-review-output-foo.json"), false);
    assert.equal(isOutputFilename("diff-report_short-tips_20260915-143045.json"), false);
  });
});
