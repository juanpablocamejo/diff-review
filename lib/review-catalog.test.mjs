import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  adoptReviewFile,
  deleteReviewJson,
  ensureFileViewerId,
  findReviewInRepo,
  listReviewCatalog,
  stampViewerId,
} from "./review-catalog.mjs";

const tmp = mkdtempSync(join(tmpdir(), "diff-review-catalog-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function repo() {
  const dir = join(tmp, String(++n));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(folder, name, payload) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, name), `${JSON.stringify(payload, null, 2)}\n`);
}

function review(meta = {}, extra = {}) {
  return {
    meta: {
      source: "local",
      repo: "C:/src/app",
      branch: "feat/x",
      base: "develop",
      agent: "Claude Code",
      model: "haiku",
      modelLabel: "Haiku 5.5",
      generatedAt: "2026-11-20T15:00:00.000Z",
      ...meta,
    },
    intent: extra.intent || "Revisar el diff de depósitos.",
    groups: extra.groups || [{ id: "g1" }],
    findings: extra.findings || [
      { id: "f1", class: "risk", blocking: true, resolution: { kind: "fix" } },
      { id: "f2", class: "quality", blocking: false },
      { id: "f3", class: "risk", blocking: true, resolution: { kind: "ignored" } },
    ],
  };
}

const NAME = "diff-rev_aaaaaaaaaa_bbbbbbbbbb.json";
const OTHER = "diff-rev_cccccccccc_dddddddddd.json";
const LEGACY = "diff-review-output.json";

test("stampViewerId no pisa un id que ya está y usa el preferido si falta", () => {
  const root = repo();
  const file = join(root, ".diff-review", NAME);
  writeJson(join(root, ".diff-review"), NAME, review());
  const first = stampViewerId(file, "11111111-1111-4111-8111-111111111111");
  assert.equal(first, "11111111-1111-4111-8111-111111111111");
  assert.equal(stampViewerId(file, "22222222-2222-4222-8222-222222222222"), first);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.meta.viewerId, first);
  assert.equal(saved.meta.agent, "Claude Code");
});

test("el catálogo lista .diff-review y la raíz, estampa una sola vez y no duplica viewerId", () => {
  const root = repo();
  writeJson(join(root, ".diff-review"), NAME, review());
  writeJson(
    join(root, ".diff-review"),
    OTHER,
    review({ branch: "feat/otro", generatedAt: "2026-11-19T10:00:00.000Z" }, { intent: "Otro diff." })
  );
  writeJson(root, LEGACY, review({ branch: "legacy", agent: "Cursor", model: "gpt", modelLabel: "" }));
  const listed = listReviewCatalog(root, [{ filename: OTHER, viewerId: "33333333-3333-4333-8333-333333333333" }]);
  assert.equal(new Set(listed.map((item) => item.id)).size, listed.length);
  const main = listed.find((item) => item.outputFilename === NAME);
  const other = listed.find((item) => item.outputFilename === OTHER);
  const legacy = listed.find((item) => item.outputFilename === LEGACY);
  assert.equal(main.branch, "feat/x");
  assert.equal(main.blockerCount, 1);
  assert.equal(main.qualityCount, 1);
  assert.equal(main.groupCount, 1);
  assert.equal(main.agent, "Claude Code");
  assert.equal(main.model, "Haiku 5.5");
  assert.equal(main.savedAt, "2026-11-20T15:00:00.000Z");
  assert.equal(other.id, "33333333-3333-4333-8333-333333333333");
  assert.equal(legacy.branch, "legacy");
  assert.equal(legacy.agent, "Cursor");
  assert.deepEqual(
    listReviewCatalog(root).map((item) => item.id).sort(),
    listed.map((item) => item.id).sort()
  );
});

test("la raíz con el mismo nombre no suma otra tarjeta si no tiene otro viewerId", () => {
  const root = repo();
  const id = "12121212-1212-4121-8121-121212121212";
  writeJson(join(root, ".diff-review"), NAME, review({ viewerId: id }));
  writeJson(root, NAME, review({ branch: "copia-raiz" }));
  const listed = listReviewCatalog(root);
  assert.equal(listed.filter((item) => item.outputFilename === NAME).length, 1);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, id);
  assert.equal(JSON.parse(readFileSync(join(root, NAME), "utf8")).meta.viewerId, undefined);
});

test("dos archivos con el mismo viewerId son una sola tarjeta", () => {
  const root = repo();
  const id = "13131313-1313-4131-8131-131313131313";
  writeJson(join(root, ".diff-review"), NAME, review({ viewerId: id, generatedAt: "2026-11-20T15:00:00.000Z" }));
  writeJson(
    join(root, ".diff-review"),
    "diff-rev_eeeeeeeeee_ffffffffff.json",
    review({ viewerId: id, branch: "copia", generatedAt: "2026-11-18T15:00:00.000Z" })
  );
  const listed = listReviewCatalog(root);
  assert.equal(listed.filter((item) => item.id === id).length, 1);
});

test("find abre por viewerId o por nombre y no pisa un id ya escrito", () => {
  const root = repo();
  const fresh = "diff-review-output-20261120-120000.json";
  writeJson(join(root, ".diff-review"), fresh, review({ branch: "nuevo" }));
  const opened = findReviewInRepo(root, {
    viewerId: "44444444-4444-4444-8444-444444444444",
    filename: fresh,
  });
  assert.equal(opened.viewerId, "44444444-4444-4444-8444-444444444444");
  assert.equal(opened.filename, fresh);
  assert.equal(findReviewInRepo(root, { viewerId: opened.viewerId }).filename, fresh);
  const kept = findReviewInRepo(root, {
    viewerId: "55555555-5555-4555-8555-555555555555",
    filename: fresh,
  });
  assert.equal(kept.viewerId, opened.viewerId);
});

test("adopt estampa, escribe en .diff-review si falta y no inventa un segundo id", () => {
  const root = repo();
  writeJson(root, LEGACY, review({ branch: "legacy" }));
  const stamped = adoptReviewFile(root, { filename: LEGACY, viewerId: "66666666-6666-4666-8666-666666666666" });
  assert.equal(stamped.status, "stamped");
  assert.equal(stamped.viewerId, "66666666-6666-4666-8666-666666666666");
  const kept = adoptReviewFile(root, { filename: LEGACY, viewerId: "77777777-7777-4777-8777-777777777777" });
  assert.equal(kept.status, "kept");
  assert.equal(kept.viewerId, stamped.viewerId);

  const createdName = "diff-report_aaaaaaaaaa-bbbbbbbbbb_20261120-153000.json";
  const written = adoptReviewFile(root, {
    filename: createdName,
    viewerId: "88888888-8888-4888-8888-888888888888",
    payload: review({ branch: "recuperado", viewerId: "88888888-8888-4888-8888-888888888888" }),
  });
  assert.equal(written.status, "written");
  assert.equal(existsSync(join(root, ".diff-review", createdName)), true);
  assert.equal(existsSync(join(root, createdName)), false);

  const absent = adoptReviewFile(root, {
    filename: "diff-rev_ababababab_cdcdcdcdcd.json",
    viewerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  assert.equal(absent.status, "missing");
  assert.equal(existsSync(join(root, ".diff-review", "diff-rev_ababababab_cdcdcdcdcd.json")), false);
});

test("delete borra el JSON y la copia con el mismo id, no archivos ajenos", () => {
  const root = repo();
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const keep = "diff-rev_1212121212_3434343434.json";
  const copy = "diff-rev_aaaaaaaaaa_bbbbbbbbbb_cccccccccc.json";
  writeJson(join(root, ".diff-review"), LEGACY, review({ viewerId: id }));
  writeJson(root, LEGACY, review({ viewerId: id, branch: "raiz" }));
  writeJson(join(root, ".diff-review"), copy, review({ viewerId: id, branch: "copia" }));
  writeJson(join(root, ".diff-review"), keep, review({ viewerId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }));
  writeJson(root, "secret.json", { no: true });

  assert.equal(deleteReviewJson(root, LEGACY, id), true);
  assert.equal(existsSync(join(root, ".diff-review", LEGACY)), false);
  assert.equal(existsSync(join(root, LEGACY)), false);
  assert.equal(existsSync(join(root, ".diff-review", copy)), false);
  assert.equal(existsSync(join(root, ".diff-review", keep)), true);
  assert.equal(existsSync(join(root, "secret.json")), true);
  assert.throws(() => deleteReviewJson(root, "../secret.json"), /inválido/);
  assert.throws(() => deleteReviewJson(root, "secret.json"), /inválido/);
  assert.equal(existsSync(join(root, "secret.json")), true);
  assert.equal(ensureFileViewerId(root, keep, "dddddddd-dddd-4ddd-8ddd-dddddddddddd").viewerId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
});
