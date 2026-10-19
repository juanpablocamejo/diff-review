import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decidePermission,
  humanizePolicyReason,
  permissionOutcome,
  toolCallCommand,
  toolCallLabel,
} from "./acp-policy.mjs";

const repo = process.platform === "win32" ? "C:\\repos\\app" : "/repos/app";
const out = "diff-rev_75eca0c739_52eb729c8f.json";
const ctx = (mode = "review") => ({ repo, outputFilename: out, mode });
const outPath = join(repo, ".diff-review", out);

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
  assert.equal(decidePermission({ kind: "read", title: "Read", rawInput: {} }, ctx()).allow, false);
  assert.equal(decidePermission({ kind: "search", title: "Grep", rawInput: { pattern: "x" } }, ctx()).allow, false);
  assert.equal(decidePermission({ kind: "search", title: "Grep", rawInput: { pattern: "x", path: "lib" } }, ctx()).allow, true);
});

test("decidePermission: symlink dentro del repo que apunta afuera no pasa", () => {
  const root = mkdtempSync(join(tmpdir(), "dr-policy-"));
  const outside = mkdtempSync(join(tmpdir(), "dr-policy-out-"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "lib", "ok.mjs"), "ok");
  const link = join(root, "escape");
  try {
    // junction en Windows no pide admin; 'dir' en posix.
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    // Entornos sin permiso de symlink: no fallar el suite.
    if (err && (err.code === "EPERM" || err.code === "EACCES")) return;
    throw err;
  }
  const local = (mode = "review") => ({ repo: root, outputFilename: out, mode });
  try {
    assert.equal(decidePermission(read(join(root, "lib", "ok.mjs")), local()).allow, true);
    assert.equal(decidePermission(read(join(link, "secret.txt")), local()).allow, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("decidePermission: escritura solo del JSON objetivo, nunca en modo pregunta ni fuera", () => {
  assert.equal(decidePermission(edit(outPath), ctx("review")).allow, true);
  assert.equal(decidePermission(edit(`.diff-review/${out}`), ctx("edit")).allow, true);
  assert.equal(decidePermission(edit(join(repo, ".diff-review", "scratch.tmp")), ctx("review")).allow, false);
  assert.equal(decidePermission(edit(join(repo, ".diff-review", out.replace(/\.json$/i, ".diff"))), ctx("review")).allow, false);
  assert.equal(decidePermission(edit(outPath), ctx("ask")).allow, false);
  // Fuera de .diff-review/: no.
  assert.equal(decidePermission(edit(join(repo, out)), ctx("review")).allow, false);
  assert.equal(decidePermission(edit(join(repo, "lib", "a.mjs")), ctx("edit")).allow, false);
  assert.equal(decidePermission({ kind: "edit", title: "Edit", rawInput: {} }, ctx("edit")).allow, false);
  // Claude manda el Write con el path solo en el diff de `content`.
  const write = (path) => ({ kind: "edit", title: "Write", rawInput: {}, locations: [], content: [{ type: "diff", path, oldText: null, newText: "{}" }] });
  assert.equal(decidePermission(write(outPath), ctx("review")).allow, true);
  assert.equal(decidePermission(write(join(repo, "x.json")), ctx("review")).allow, false);
  assert.equal(
    decidePermission({ kind: "delete", title: "Delete", rawInput: { path: outPath }, locations: [{ path: outPath }] }, ctx("review"))
      .allow,
    true
  );
  assert.equal(
    decidePermission(
      { kind: "delete", title: "Delete", rawInput: { path: join(repo, "lib", "a.mjs") }, locations: [{ path: join(repo, "lib", "a.mjs") }] },
      ctx("review")
    ).allow,
    false
  );
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

test("toolCallCommand / toolCallLabel y humanizePolicyReason para la UI de permisos", () => {
  assert.equal(toolCallCommand({ kind: "execute", rawInput: { command: "git status" } }), "git status");
  assert.equal(toolCallCommand({ kind: "execute", title: "`ls -la`" }), "ls -la");
  assert.equal(
    toolCallCommand({ kind: "execute", title: "@\nnode -e 'x'\n@" }),
    "node -e 'x'"
  );
  assert.equal(toolCallLabel({ title: "Probe symlink" }, "node -e 'x'"), "Probe symlink");
  assert.equal(toolCallLabel({ title: "`ls`" }, "ls"), "");
  assert.equal(toolCallLabel({ title: "@node@" }, "node"), "");
  assert.match(humanizePolicyReason("node no está permitido"), /allowlist/);
  assert.match(humanizePolicyReason("variables de entorno en el comando: @"), /variable de entorno/);
});

test("permissionOutcome elige once / always según el scope", () => {
  const options = [
    { optionId: "a1", kind: "allow_always", name: "Siempre" },
    { optionId: "a", kind: "allow_once", name: "Sí" },
    { optionId: "r", kind: "reject_once", name: "No" },
  ];
  assert.deepEqual(permissionOutcome(options, true), { outcome: { outcome: "selected", optionId: "a" } });
  assert.deepEqual(permissionOutcome(options, true, { always: true }), {
    outcome: { outcome: "selected", optionId: "a1" },
  });
  assert.deepEqual(permissionOutcome(options, false), { outcome: { outcome: "selected", optionId: "r" } });
  // Sin allow_once: allow “una vez” no puede inventar always.
  assert.deepEqual(permissionOutcome([{ optionId: "a1", kind: "allow_always" }], true), {
    outcome: { outcome: "cancelled" },
  });
  // Sin allow_always: “siempre” cae a once.
  assert.deepEqual(permissionOutcome([{ optionId: "a", kind: "allow_once" }], true, { always: true }), {
    outcome: { outcome: "selected", optionId: "a" },
  });
});
