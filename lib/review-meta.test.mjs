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

  stampReviewProvenance(file, { agent: "Cursor" });

  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.meta.agent, "Cursor");
  assert.equal(saved.meta.model, "sonnet");
});

test("stampReviewProvenance guarda la sesión del agente", () => {
  const dir = mkdtempSync(join(tmpdir(), "diff-review-meta-"));
  const file = join(dir, "diff-rev_a_b.json");
  writeFileSync(file, JSON.stringify({ meta: { agent: "x" }, intent: "x" }));

  const agentSession = { agentId: "claude", sessionId: "s-1", outputFilename: "diff-rev_a_b.json" };
  stampReviewProvenance(file, { agent: "Claude Code", model: "opus", agentSession });

  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).meta.agentSession, agentSession);
});

test("stampReviewProvenance guarda el nombre con versión junto al alias", () => {
  const dir = mkdtempSync(join(tmpdir(), "diff-review-meta-"));
  const file = join(dir, "diff-rev_a_b.json");
  writeFileSync(file, JSON.stringify({ meta: { model: "claude-haiku-5-5" }, intent: "x" }));

  stampReviewProvenance(file, { agent: "Claude Code", model: "haiku", modelLabel: "Haiku 5.5" });
  let meta = JSON.parse(readFileSync(file, "utf8")).meta;
  assert.equal(meta.model, "haiku");
  assert.equal(meta.modelLabel, "Haiku 5.5");

  // Otro modelo sin nombre conocido: el label anterior ya no corresponde.
  stampReviewProvenance(file, { model: "claude-opus-5" });
  meta = JSON.parse(readFileSync(file, "utf8")).meta;
  assert.equal(meta.model, "claude-opus-5");
  assert.equal(meta.modelLabel, undefined);
});

test("stampReviewProvenance pisa la fecha que puso el agente", () => {
  const dir = mkdtempSync(join(tmpdir(), "diff-review-meta-"));
  const file = join(dir, "diff-rev_a_b.json");
  writeFileSync(file, JSON.stringify({ meta: { generatedAt: "2026-11-10T00:00:00Z", agent: "x" }, intent: "x" }));

  // Solo la fecha (flujo del portapapeles): alcanza para estampar y no toca el resto.
  assert.equal(stampReviewProvenance(file, { generatedAt: "2026-11-10T21:17:14.630Z" }), true);
  const meta = JSON.parse(readFileSync(file, "utf8")).meta;
  assert.equal(meta.generatedAt, "2026-11-10T21:17:14.630Z");
  assert.equal(meta.agent, "x");
});
