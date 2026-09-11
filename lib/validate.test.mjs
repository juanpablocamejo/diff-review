import { test } from "node:test";
import assert from "node:assert/strict";
import { REVIEW_SCHEMA, reviewIssues, jsonContract, synthesisContract, validateAgainst, SYNTHESIS_SCHEMA } from "./validate.mjs";

const valid = () => ({
  intent: "Agrega el ABM de depósitos locales end-to-end para dejar de administrarlos por SQL.",
  groups: [{ id: "g1", kind: "feat", title: "feat(product): CRUD de depósitos", intent: "base de todo" }],
  blocks: [
    { id: "b1", group: "g1", file: "src/a.ts", lines: "L1-20", op: "add", what: "controller nuevo", why: "", source: "code" },
  ],
  findings: [],
  skipped: [],
});

test("validateAgainst acepta una review bien formada", () => {
  assert.deepEqual(validateAgainst(REVIEW_SCHEMA, valid()), []);
});

test("validateAgainst exige una intención de verdad", () => {
  const errors = validateAgainst(REVIEW_SCHEMA, { ...valid(), intent: "corto" });
  assert.ok(errors.some((e) => e.includes("intent")));
});

test("validateAgainst rechaza un kind de grupo inventado", () => {
  const doc = valid();
  doc.groups[0].kind = "feature";
  const errors = validateAgainst(REVIEW_SCHEMA, doc);
  assert.ok(errors.some((e) => e.includes("kind")));
});

test("validateAgainst rechaza un bloque sin rango de líneas", () => {
  const doc = valid();
  delete doc.blocks[0].lines;
  assert.ok(validateAgainst(REVIEW_SCHEMA, doc).some((e) => e.includes("lines")));
});

test("validateAgainst acepta los dos ejes de hallazgo", () => {
  const doc = valid();
  doc.findings = [
    { id: "f1", class: "risk", severity: "high", blocking: true, kind: "bug", file: "src/a.ts", line: 4, what: "rompe" },
    { id: "f2", class: "quality", severity: "low", blocking: false, kind: "maintainability", file: "src/a.ts", line: null, what: "duplicado" },
  ];
  assert.deepEqual(validateAgainst(REVIEW_SCHEMA, doc), []);
});

test("reviewIssues detecta un bloque que apunta a un grupo inexistente", () => {
  const doc = valid();
  doc.blocks[0].group = "g9";
  const errors = reviewIssues(doc, ["src/a.ts"]);
  assert.ok(errors.some((e) => e.includes("g9")));
});

test("reviewIssues detecta un archivo del diff sin bloque ni skipped", () => {
  const errors = reviewIssues(valid(), ["src/a.ts", "src/olvidado.ts"]);
  assert.ok(errors.some((e) => e.includes("olvidado")));
});

test("reviewIssues acepta un archivo cubierto por skipped", () => {
  const doc = valid();
  doc.skipped = [{ file: "bun.lock", reason: "lockfile" }];
  assert.deepEqual(reviewIssues(doc, ["src/a.ts", "bun.lock"]), []);
});

test("reviewIssues detecta grupos huérfanos y hallazgos colgados", () => {
  const doc = valid();
  doc.groups.push({ id: "g2", kind: "test", title: "t", intent: "x" });
  doc.findings = [{ id: "f1", class: "risk", severity: "high", blocking: true, kind: "bug", file: "src/a.ts", block: "b9", what: "x" }];
  const errors = reviewIssues(doc, ["src/a.ts"]);
  assert.ok(errors.some((e) => e.includes("g2")));
  assert.ok(errors.some((e) => e.includes("b9")));
});

test("reviewIssues detecta ids repetidos", () => {
  const doc = valid();
  doc.blocks.push({ ...doc.blocks[0] });
  assert.ok(reviewIssues(doc, ["src/a.ts"]).some((e) => e.includes("repetido")));
});

test("jsonContract nombra la estructura y los enums", () => {
  const text = jsonContract();
  assert.match(text, /JSON object/);
  assert.match(text, /groups\.kind/);
  assert.match(text, /findings/);
  assert.match(text, /maintainability/);
});

test("synthesisContract pide groupMap", () => {
  assert.match(synthesisContract(), /groupMap/);
});
