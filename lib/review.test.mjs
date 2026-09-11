import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySynthesis,
  buildReview,
  countHunks,
  dominantGroup,
  formatLineRange,
  mergeReviewPayloads,
  parseLineRange,
} from "./review.mjs";
import { decodePayload } from "./json-payload.mjs";
import { REVIEW_SCHEMA, reviewIssues, validateAgainst } from "./validate.mjs";

const skeleton = () => ({
  branch: "feat/x",
  baseBranch: "develop",
  stats: { filesChanged: 2, insertions: 10, deletions: 2 },
  context: { ignored: ["bun.lock"] },
  files: [
    { path: "src/a.ts", changeType: "modified", diff: "@@ -1,3 +1,5 @@\n+uno\n@@ -20,2 +22,4 @@\n+dos" },
    { path: "src/a.test.ts", changeType: "added", diff: "@@ -0,0 +1,9 @@\n+test" },
  ],
});

const payload = () => ({
  intent: "Agrega el ABM de depósitos locales end-to-end para dejar de administrarlos a mano por SQL.",
  groups: [
    { id: "g1", kind: "feat", title: "feat(product): CRUD de depósitos", intent: "la funcionalidad" },
    { id: "g2", kind: "test", title: "test(warehouses): cubrir el CRUD", intent: "red de seguridad" },
  ],
  blocks: [
    { id: "b1", group: "g1", file: "src/a.ts", lines: "L22-25", op: "add", what: "endpoint nuevo", why: "hacía falta", source: "code" },
    { id: "b2", group: "g1", file: "src/a.ts", lines: "L1-5", op: "mod", what: "registra el service", why: "", source: "inferred" },
    { id: "b3", group: "g2", file: "src/a.test.ts", lines: "L1-9", op: "add", what: "tests del CRUD", why: "", source: "code" },
  ],
  findings: [],
  skipped: [],
});

test("parseLineRange entiende post-imagen, pre-imagen y línea suelta", () => {
  assert.deepEqual(parseLineRange("L40-58"), { side: "new", start: 40, end: 58 });
  assert.deepEqual(parseLineRange("-L88-95"), { side: "old", start: 88, end: 95 });
  assert.deepEqual(parseLineRange("L7"), { side: "new", start: 7, end: 7 });
  assert.deepEqual(parseLineRange("12-9"), { side: "new", start: 9, end: 12 });
  assert.equal(parseLineRange("por ahí"), null);
});

test("formatLineRange redondea el viaje de ida y vuelta", () => {
  assert.equal(formatLineRange(parseLineRange("40-58")), "L40-58");
  assert.equal(formatLineRange(parseLineRange("-L88")), "-L88");
});

test("countHunks cuenta las cabeceras @@", () => {
  assert.equal(countHunks(skeleton().files), 3);
});

test("dominantGroup gana por cantidad de bloques", () => {
  const blocks = [
    { file: "a.ts", group: "g2" },
    { file: "a.ts", group: "g1" },
    { file: "a.ts", group: "g1" },
  ];
  assert.equal(dominantGroup(blocks, "a.ts", ["g1", "g2"]), "g1");
  assert.equal(dominantGroup(blocks, "otro.ts", ["g1", "g2"]), "");
});

test("buildReview arma el documento y ubica cada archivo en su grupo dominante", () => {
  const doc = buildReview({ skeleton: skeleton(), payload: payload() });
  assert.equal(doc.version, 2);
  assert.equal(doc.groups.length, 2);
  assert.equal(doc.blocks.length, 3);
  assert.equal(doc.stats.hunks, 3);
  assert.equal(doc.files.find((f) => f.path === "src/a.ts").group, "g1");
  assert.equal(doc.files.find((f) => f.path === "src/a.test.ts").group, "g2");
  assert.deepEqual(doc.notes, []);
});

test("buildReview ordena los bloques por archivo y línea", () => {
  const doc = buildReview({ skeleton: skeleton(), payload: payload() });
  assert.deepEqual(doc.blocks.map((b) => b.id), ["b3", "b2", "b1"]);
});

test("buildReview descarta bloques que apuntan a grupos o archivos fantasma", () => {
  const bad = payload();
  bad.blocks.push({ id: "b9", group: "g7", file: "src/a.ts", lines: "L1", op: "mod", what: "x" });
  bad.blocks.push({ id: "b8", group: "g1", file: "src/inventado.ts", lines: "L1", op: "mod", what: "x" });
  const doc = buildReview({ skeleton: skeleton(), payload: bad });
  assert.deepEqual(doc.blocks.map((b) => b.id).sort(), ["b1", "b2", "b3"]);
});

test("buildReview tira los grupos sin bloques", () => {
  const bad = payload();
  bad.groups.push({ id: "g3", kind: "chore", title: "sobra", intent: "" });
  const doc = buildReview({ skeleton: skeleton(), payload: bad });
  assert.deepEqual(doc.groups.map((g) => g.id), ["g1", "g2"]);
});

test("buildReview avisa cuando un archivo quedó sin explicar", () => {
  const bad = payload();
  bad.blocks = bad.blocks.filter((b) => b.file !== "src/a.test.ts");
  const doc = buildReview({ skeleton: skeleton(), payload: bad });
  assert.ok(doc.notes[0].includes("sin explicación"));
});

test("buildReview suma los archivos ignorados a skipped", () => {
  const doc = buildReview({ skeleton: skeleton(), payload: payload() });
  assert.deepEqual(doc.skipped, [{ file: "bun.lock", reason: "ignored" }]);
});

test("buildReview conserva los nit de calidad pero no los deja bloquear", () => {
  const withFindings = payload();
  withFindings.findings = [
    { class: "quality", severity: "nit", blocking: true, kind: "maintainability", file: "src/a.ts", line: 3, what: "nombre confuso", fix: "renombrar" },
    { class: "risk", severity: "high", kind: "bug", file: "src/a.ts", line: 22, block: "b1", what: "explota con null", fix: "guardar" },
  ];
  const doc = buildReview({ skeleton: skeleton(), payload: withFindings });
  assert.equal(doc.findings.length, 2);
  assert.equal(doc.findings[0].id, "f1");
  assert.equal(doc.findings[0].kind, "bug");
  assert.equal(doc.findings[0].blocking, true);
  assert.equal(doc.findings[1].severity, "nit");
  assert.equal(doc.findings[1].blocking, false);
});

test("buildReview deduplica hallazgos repetidos y limpia referencias colgadas", () => {
  const withFindings = payload();
  const one = { class: "risk", severity: "med", kind: "bug", file: "src/a.ts", line: 5, what: "mismo", block: "b404" };
  withFindings.findings = [one, { ...one }];
  const doc = buildReview({ skeleton: skeleton(), payload: withFindings });
  assert.equal(doc.findings.length, 1);
  assert.equal(doc.findings[0].block, "");
});

test("una respuesta JSON del modelo atraviesa decode, validación y normalización", () => {
  const answer = JSON.stringify({
    intent: "Hace que las búsquedas con varias palabras matcheen los tokens en cualquier orden.",
    groups: [
      { id: "g1", kind: "feat", title: "feat(search): matchear tokens", intent: "el cambio" },
      { id: "g2", kind: "test", title: "test(search): cubrir tokens", intent: "red de seguridad" },
    ],
    blocks: [
      { id: "b1", group: "g1", file: "src/a.ts", lines: "L22-25", op: "add", what: "tokens AND", why: "antes frase exacta", source: "commit" },
      { id: "b2", group: "g1", file: "src/a.ts", lines: "L1-5", op: "mod", what: "registra rewriter", why: "", source: "inferred" },
      { id: "b3", group: "g2", file: "src/a.test.ts", lines: "L1-9", op: "add", what: "tests", why: "", source: "code" },
    ],
    findings: [
      { id: "f1", class: "risk", severity: "high", blocking: true, kind: "bug", file: "src/a.ts", line: 23, block: "b1", what: "AND vacío", fix: "cortar temprano" },
      { id: "f2", class: "quality", severity: "low", blocking: false, kind: "maintainability", file: "src/a.ts", line: 3, block: "b2", what: "split repetido", fix: "extraer tokenize" },
    ],
    skipped: [],
  });

  const payload = decodePayload(answer);
  assert.deepEqual(validateAgainst(REVIEW_SCHEMA, payload), []);
  assert.deepEqual(reviewIssues(payload, ["src/a.ts", "src/a.test.ts"]), []);

  const doc = buildReview({ skeleton: skeleton(), payload });
  assert.equal(doc.groups.length, 2);
  assert.equal(doc.blocks.length, 3);
  assert.deepEqual(doc.notes, []);
});

test("applySynthesis remapea groups en blocks", () => {
  const merged = mergeReviewPayloads([
    {
      intent: "parcial",
      groups: [{ id: "g11", kind: "feat", title: "t1", intent: "a" }],
      blocks: [{ id: "b11", group: "g11", file: "src/a.ts", lines: "L1", op: "mod", what: "x" }],
      findings: [],
      skipped: [],
    },
    {
      intent: "otra",
      groups: [{ id: "g21", kind: "test", title: "t2", intent: "b" }],
      blocks: [{ id: "b21", group: "g21", file: "src/a.test.ts", lines: "L1", op: "add", what: "y" }],
      findings: [],
      skipped: [],
    },
  ]);
  const out = applySynthesis(merged, {
    intent: "Intención unificada del branch completo con más de cuarenta caracteres.",
    groups: [
      { id: "g1", kind: "feat", title: "feat: todo", intent: "unificado" },
      { id: "g2", kind: "test", title: "test: todo", intent: "tests" },
    ],
    groupMap: { g11: "g1", g21: "g2" },
  });
  assert.equal(out.intent.startsWith("Intención unificada"), true);
  assert.deepEqual(out.groups.map((g) => g.id), ["g1", "g2"]);
  assert.equal(out.blocks.find((b) => b.id === "b11").group, "g1");
  assert.equal(out.blocks.find((b) => b.id === "b21").group, "g2");
});

test("mergeReviewPayloads concatena lotes y se queda con la primera intención", () => {
  const merged = mergeReviewPayloads([
    { intent: "primera", groups: [{ id: "g1" }], blocks: [{ id: "b1" }] },
    { intent: "segunda", groups: [{ id: "g2" }], findings: [{ id: "f1" }] },
  ]);
  assert.equal(merged.intent, "primera");
  assert.deepEqual(merged.groups.map((g) => g.id), ["g1", "g2"]);
  assert.equal(merged.blocks.length, 1);
  assert.equal(merged.findings.length, 1);
});
