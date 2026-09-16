import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isOutputFilename,
  makeOutputFilename,
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

  it("rejects other names", () => {
    assert.equal(isOutputFilename("review.json"), false);
    assert.equal(isOutputFilename("diff-review-output-foo.json"), false);
    assert.equal(isOutputFilename("diff-rev_short_tips.json"), false);
  });
});
