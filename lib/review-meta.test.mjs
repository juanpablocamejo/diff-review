import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stampReviewProvenance } from "./review-meta.mjs";

test("stampReviewProvenance escribe agente y modelo sin perder el resto", () => {
  const dir = mkdtempSync(join(tmpdir(), "diff-review-meta-"));
  const file = join(dir, "diff-rev_a_b.json");
  writeFileSync(file, JSON.stringify({ intent: "algo concreto", meta: { branch: "feat" } }));

  assert.equal(stampReviewProvenance(file, { agent: "Claude Code", model: "opus" }), true);

  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.intent, "algo concreto");
  assert.deepEqual(saved.meta, { branch: "feat", agent: "Claude Code", model: "opus" });
});

test("stampReviewProvenance no pisa el modelo si no hay uno", () => {
  const dir = mkdtempSync(join(tmpdir(), "diff-review-meta-"));
  const file = join(dir, "diff-rev_a_b.json");
  writeFileSync(file, JSON.stringify({ meta: { model: "sonnet" }, intent: "x" }));

  stampReviewProvenance(file, { agent: "Codex" });

  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.meta.agent, "Codex");
  assert.equal(saved.meta.model, "sonnet");
});
