import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { listSavedReports, normalizePrompts, reportMeta } from "./reports.mjs";

const doc = (extra = {}) => ({
  version: 2,
  branch: "feat/x",
  baseBranch: "develop",
  generatedAt: "2026-02-01T00:00:00.000Z",
  intent: "Agrega el ABM.",
  stats: { filesChanged: 3, insertions: 40, deletions: 4, filesIgnored: 1 },
  groups: [{ id: "g1" }, { id: "g2" }],
  blocks: [{ id: "b1" }, { id: "b2" }, { id: "b3" }],
  findings: [
    { id: "f1", class: "risk", blocking: true },
    { id: "f2", class: "risk", blocking: false },
    { id: "f3", class: "quality", blocking: false },
  ],
  ...extra,
});

test("reportMeta cuenta grupos, bloques, bloqueantes y calidad", () => {
  const meta = reportMeta(doc(), "aaaa-bbbb");
  assert.equal(meta.version, 2);
  assert.equal(meta.intent, "Agrega el ABM.");
  assert.equal(meta.groupCount, 2);
  assert.equal(meta.blockCount, 3);
  assert.equal(meta.blockerCount, 1);
  assert.equal(meta.qualityCount, 1);
  assert.equal(meta.ignored, 1);
});

test("reportMeta lee el resumen viejo de los reportes v1", () => {
  const legacy = { branch: "feat/x", summary: "resumen viejo", sections: [] };
  const meta = reportMeta(legacy, "old");
  assert.equal(meta.version, 1);
  assert.equal(meta.intent, "resumen viejo");
  assert.equal(meta.blockerCount, 0);
});

test("normalizePrompts acepta los pasos nuevos y cae en review", () => {
  const prompts = normalizePrompts([
    { step: "review", label: "Review", prompt: "hola" },
    { step: "grouping", label: "viejo", prompt: "x" },
  ]);
  assert.equal(prompts[0].step, "review");
  assert.equal(prompts[0].chars, 4);
  assert.equal(prompts[1].step, "review");
});

test("listSavedReports ordena por fecha y saltea los json rotos", () => {
  const dir = mkdtempSync(join(tmpdir(), "diff-review-list-"));
  try {
    writeFileSync(join(dir, "aaaa-bbbb.json"), JSON.stringify(doc({ generatedAt: "2026-01-01T00:00:00.000Z" })));
    writeFileSync(join(dir, "cccc-dddd.json"), JSON.stringify(doc({ generatedAt: "2026-03-01T00:00:00.000Z" })));
    writeFileSync(join(dir, "roto.json"), "{ no json");
    const reports = listSavedReports(dir);
    assert.deepEqual(reports.map((r) => r.id), ["cccc-dddd", "aaaa-bbbb"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
