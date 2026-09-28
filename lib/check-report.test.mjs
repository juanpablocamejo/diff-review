import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPayload, formatCheckReport } from "./check-report.mjs";

const valid = () => ({
  intent: "Agrega el ABM de depósitos locales end-to-end para dejar de administrarlos por SQL.",
  groups: [{ id: "g1", kind: "feat", title: "CRUD de depósitos", intent: "base de todo" }],
  blocks: [
    {
      id: "b1",
      group: "g1",
      file: "src/a.ts",
      lines: "L1-20",
      op: "add",
      what: "controller nuevo",
      why: "",
      source: "code",
    },
  ],
  findings: [],
  skipped: [{ file: "**/*.lock", reason: "lockfile" }],
});

test("checkPayload acepta cobertura exacta y por glob", () => {
  const result = checkPayload(valid(), ["src/a.ts", "bun.lock"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("checkPayload lista archivos del diff sin cubrir", () => {
  const result = checkPayload(valid(), ["src/a.ts", "src/olvidado.ts"]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("src/olvidado.ts")));
});

test("formatCheckReport explica cómo seguir", () => {
  const text = formatCheckReport("diff-rev_a_b.json", "npx --yes @jpkme/diff-review validate diff-rev_a_b.json", {
    ok: false,
    errors: ["$.intent: texto demasiado corto"],
    notes: [],
  });
  assert.match(text, /INVALID/);
  assert.match(text, /How to continue/);
  assert.match(text, /npx --yes @jpkme\/diff-review validate/);
  assert.match(text, /same file/);
});
