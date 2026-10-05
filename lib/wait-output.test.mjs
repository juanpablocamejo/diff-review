import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { existingReviewOutput, waitForReviewOutput } from "./wait-output.mjs";

const valid = () => ({
  intent: "Agrega el ABM de depósitos locales end-to-end para dejar de administrarlos por SQL.",
  groups: [{ id: "g1", kind: "feat", title: "feat(product): CRUD de depósitos", intent: "base de todo" }],
  blocks: [
    { id: "b1", group: "g1", file: "src/a.ts", lines: "L1-20", op: "add", what: "controller nuevo", why: "", source: "code" },
  ],
  findings: [],
  skipped: [],
});

const FILE = "diff-rev_a_b.json";

function repoWith(payload) {
  const repo = mkdtempSync(join(tmpdir(), "diff-review-wait-"));
  if (payload !== undefined) writeFileSync(join(repo, FILE), JSON.stringify(payload));
  return repo;
}

/** Atrasa el mtime del archivo, como si viniera de una corrida anterior. */
function age(repo, ms) {
  const past = new Date(Date.now() - ms);
  utimesSync(join(repo, FILE), past, past);
}

describe("existingReviewOutput", () => {
  it("devuelve el JSON si existe y es válido", () => {
    const repo = repoWith(valid());
    assert.equal(existingReviewOutput(repo, FILE)?.path, join(repo, FILE));
  });

  it("null si no existe o es inválido", () => {
    assert.equal(existingReviewOutput(repoWith(), FILE), null);
    assert.equal(existingReviewOutput(repoWith({ intent: "corto" }), FILE), null);
  });
});

describe("waitForReviewOutput", () => {
  it("sin since toma un JSON válido que ya estaba", async () => {
    const repo = repoWith(valid());
    age(repo, 60_000);
    const result = await waitForReviewOutput(repo, FILE, { pollMs: 20 });
    assert.equal(result.path, join(repo, FILE));
  });

  it("con since ignora el JSON anterior y resuelve cuando se reescribe", async () => {
    const repo = repoWith(valid());
    age(repo, 60_000);
    let resolved = false;
    const waiting = waitForReviewOutput(repo, FILE, { pollMs: 20, since: Date.now() - 1000 }).then((r) => {
      resolved = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(resolved, false);

    writeFileSync(join(repo, FILE), JSON.stringify(valid()));
    const result = await waiting;
    assert.equal(result.path, join(repo, FILE));
  });
});
