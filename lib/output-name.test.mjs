import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isOutputFilename,
  makeOutputFilename,
  makeStampedOutputFilename,
  OUTPUT_FILENAME_LEGACY,
} from "./output-name.mjs";

describe("output-name", () => {
  it("builds name with short tip hashes", () => {
    const name = makeOutputFilename({
      branchSha: "aaaaaaaaaa1111111111",
      baseSha: "bbbbbbbbbb2222222222",
    });
    assert.equal(name, "diff-rev_aaaaaaaaaa_bbbbbbbbbb.json");
    assert.equal(isOutputFilename(name), true);
  });

  it("adds a diff-content hash so a dirty tree does not reuse the clean name", () => {
    const clean = makeOutputFilename({
      branchSha: "aaaaaaaaaa1111111111",
      baseSha: "bbbbbbbbbb2222222222",
      diffHash: "cccccccccc",
    });
    const dirty = makeOutputFilename({
      branchSha: "aaaaaaaaaa1111111111",
      baseSha: "bbbbbbbbbb2222222222",
      diffHash: "dddddddddd",
    });
    assert.equal(clean, "diff-rev_aaaaaaaaaa_bbbbbbbbbb_cccccccccc.json");
    assert.equal(dirty, "diff-rev_aaaaaaaaaa_bbbbbbbbbb_dddddddddd.json");
    assert.notEqual(clean, dirty);
    assert.equal(isOutputFilename(clean), true);
    assert.equal(isOutputFilename("diff-rev_aaaaaaaaaa_bbbbbbbbbb.json"), true);
  });

  it("falls back to legacy without tips", () => {
    assert.equal(makeOutputFilename({}), OUTPUT_FILENAME_LEGACY);
    assert.equal(isOutputFilename(OUTPUT_FILENAME_LEGACY), true);
  });

  it("accepts legacy stamped and report names", () => {
    assert.equal(isOutputFilename("diff-review-output-20260915-143045.json"), true);
    assert.equal(
      isOutputFilename("diff-report_aaaaaaaaaa-bbbbbbbbbb_20260915-143045.json"),
      true
    );
  });

  it("stamps a distinct legacy name so a new review does not reuse the open file", () => {
    const now = new Date(2026, 8, 15, 14, 30, 45);
    const name = makeStampedOutputFilename({
      branchSha: "aaaaaaaaaa1111111111",
      baseSha: "bbbbbbbbbb2222222222",
      now,
    });
    assert.equal(name, "diff-report_aaaaaaaaaa-bbbbbbbbbb_20260915-143045.json");
    assert.equal(isOutputFilename(name), true);
    assert.notEqual(
      name,
      makeOutputFilename({
        branchSha: "aaaaaaaaaa1111111111",
        baseSha: "bbbbbbbbbb2222222222",
        diffHash: "cccccccccc",
      })
    );
    assert.equal(
      isOutputFilename(makeStampedOutputFilename({ now })),
      true
    );
  });

  it("rejects other names", () => {
    assert.equal(isOutputFilename("review.json"), false);
    assert.equal(isOutputFilename("diff-review-output-foo.json"), false);
    assert.equal(isOutputFilename("diff-rev_short_tips.json"), false);
  });
});
