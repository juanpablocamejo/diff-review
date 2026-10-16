import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { decidePermission, permissionOutcome } from "./acp-policy.mjs";

const repo = process.platform === "win32" ? "C:\\repos\\app" : "/repos/app";
const out = "diff-rev_75eca0c739_52eb729c8f.json";
const ctx = (mode = "review") => ({ repo, outputFilename: out, mode });

// Formas reales que manda claude-agent-acp.
const bash = (command) => ({ kind: "execute", title: command, rawInput: { command, description: "x" } });
const read = (file_path) => ({ kind: "read", title: "Read", rawInput: { file_path }, locations: [{ path: file_path, line: 1 }] });
const edit = (file_path) => ({ kind: "edit", title: "Write", rawInput: { file_path, content: "{}" }, locations: [{ path: file_path }] });

test("decidePermission: lecturas solo dentro del repo", () => {
  assert.equal(decidePermission(read(join(repo, "lib", "a.mjs")), ctx()).allow, true);
  assert.equal(decidePermission(read("lib/a.mjs"), ctx()).allow, true);
  const home = process.platform === "win32" ? "C:\\Users\\me\\.ssh\\id_rsa" : "/home/me/.ssh/id_rsa";
  assert.equal(decidePermission(read(home), ctx()).allow, false);
  assert.equal(decidePermission(read(join(repo, "..", "otro", "x")), ctx()).allow, false);
});

test("decidePermission: solo se escribe el JSON de la review, y nunca en modo pregunta", () => {
  assert.equal(decidePermission(edit(join(repo, out)), ctx("review")).allow, true);
  assert.equal(decidePermission(edit(out), ctx("edit")).allow, true);
  assert.equal(decidePermission(edit(join(repo, out)), ctx("ask")).allow, false);
  assert.equal(decidePermission(edit(join(repo, "lib", "a.mjs")), ctx("edit")).allow, false);
  assert.equal(decidePermission({ kind: "edit", title: "Edit", rawInput: {} }, ctx("edit")).allow, false);
  // Claude manda el Write con el path solo en el diff de `content`.
  const write = (path) => ({ kind: "edit", title: "Write", rawInput: {}, locations: [], content: [{ type: "diff", path, oldText: null, newText: "{}" }] });
  assert.equal(decidePermission(write(join(repo, out)), ctx("review")).allow, true);
  assert.equal(decidePermission(write(join(repo, "x.json")), ctx("review")).allow, false);
});

test("decidePermission: comandos según isAllowedShell y el resto rechazado", () => {
  assert.equal(decidePermission(bash("git diff a...b"), ctx("ask")).allow, true);
  assert.equal(decidePermission(bash("rm -rf ."), ctx()).allow, false);
  // Cursor: sin rawInput, el comando entre backticks en el título.
  const cursor = (cmd) => ({ kind: "execute", title: `\`${cmd}\`` });
  assert.equal(decidePermission(cursor("git log --oneline -3"), ctx()).allow, true);
  assert.equal(decidePermission(cursor("echo hola > hola.txt"), ctx()).allow, false);
  // El motivo del rechazo dice qué falló (lo ve el usuario en la web).
  assert.match(decidePermission(bash("git diff > x.patch"), ctx()).reason, /redirección/);
  assert.equal(decidePermission({ kind: "fetch", title: "WebFetch", rawInput: { url: "https://x" } }, ctx()).allow, false);
  assert.equal(decidePermission({ kind: "delete", title: "rm", rawInput: {} }, ctx("edit")).allow, false);
});

test("permissionOutcome elige la opción de una vez", () => {
  const options = [
    { optionId: "a1", kind: "allow_always", name: "Siempre" },
    { optionId: "a", kind: "allow_once", name: "Sí" },
    { optionId: "r", kind: "reject_once", name: "No" },
  ];
  assert.deepEqual(permissionOutcome(options, true), { outcome: { outcome: "selected", optionId: "a" } });
  assert.deepEqual(permissionOutcome(options, false), { outcome: { outcome: "selected", optionId: "r" } });
  assert.deepEqual(permissionOutcome([{ optionId: "a1", kind: "allow_always" }], true), { outcome: { outcome: "cancelled" } });
});
