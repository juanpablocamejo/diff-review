import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkShell, tokenizeShell } from "./acp-shell.mjs";

const win = process.platform === "win32";
const repo = win ? "C:\\repos\\app" : "/repos/app";
const out = "diff-rev_75eca0c739_52eb729c8f.json";
const ok = (cmd) => checkShell(cmd, { repo }).ok;

test("tokenizeShell respeta comillas y separa cadenas y pipes", () => {
  const parsed = tokenizeShell(`git show main:a.ts | grep -n "a\\|b|c" ; echo 'x; y' && ls`);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.pipelines, [
    [
      ["git", "show", "main:a.ts"],
      ["grep", "-n", "a\\|b|c"],
    ],
    [["echo", "x; y"]],
    [["ls"]],
  ]);
});

test("tokenizeShell descarta salida a /dev/null y rechaza el resto de redirecciones", () => {
  assert.equal(tokenizeShell("git diff 2>&1").ok, true);
  assert.equal(tokenizeShell("git diff 2>/dev/null || true").ok, true);
  assert.equal(tokenizeShell("git diff &>/dev/null").ok, true);
  assert.equal(tokenizeShell("Get-Content a.txt 2>$null").ok, true);
  assert.equal(tokenizeShell("git diff > x.patch").ok, false);
  assert.equal(tokenizeShell("git diff >> x.patch").ok, false);
  assert.equal(tokenizeShell("cat < a").ok, false);
  assert.equal(tokenizeShell('echo "$(whoami)"').ok, false);
  assert.equal(tokenizeShell("echo `whoami`").ok, false);
  assert.equal(tokenizeShell("sleep 1 & curl x").ok, false);
  assert.equal(tokenizeShell('echo "sin cerrar').ok, false);
});

test("checkShell deja git de lectura, el validate y comandos que solo leen", () => {
  for (const cmd of [
    "git diff main~1...main",
    "git --no-pager log --oneline -5",
    `git -C "${repo}" diff --stat a...b`,
    "git merge-base develop feat/x && git diff --stat develop...feat/x",
    "git show HEAD:lib/a.mjs | head -50",
    "git branch --show-current",
    "git remote get-url origin",
    "git config --get remote.origin.url",
    `npx --yes @jpkme/diff-review validate ${out}`,
    `npx --yes @jpkme/diff-review@latest validate ${out}`,
    `cd "${repo}" && git diff a...b`,
    `cd "${repo}"; git diff`,
    // Lo que mandó Claude en las pruebas.
    `git show main:web/src/routes/+page.svelte | sed -n 560,660p; git show main:web/src/lib/report/storage.ts | sed -n 1,60p`,
    `git show main:web/src/routes/+page.svelte | grep -n -A6 "function updateMeta\\|openNewReport(pendingDoc\\|const ctx"`,
    `grep -rn "validateDocument(" web/src --include="*.ts"`,
    "cat package.json | head -20",
    "ls -la lib",
    "find web/src -name '*.svelte' -type f",
    "wc -l lib/*.mjs",
    "rg -n 'export function' lib",
    "sed -n '10,40p' lib/agents.mjs",
    "git diff a...b -- lib 2>/dev/null || true",
    "Get-Content lib/agents.mjs | Select-Object -First 40",
    "Select-String -Path lib/*.mjs -Pattern 'export'",
    // Agrupación PowerShell: `(cmd).Property` (Copilot/Opus suele contar líneas así).
    "(Get-Content lib/agents.mjs).Count",
    "(Get-Content .diff-review/diff-rev_x.diff).Count",
    "(Get-Content lib/a.mjs | Measure-Object -Line).Lines",
  ]) {
    assert.equal(ok(cmd), true, cmd);
  }
});

test("checkShell rechaza escrituras, ejecución y paths fuera del repo", () => {
  const home = win ? "C:\\Users\\me\\.ssh\\id_rsa" : "/home/me/.ssh/id_rsa";
  for (const cmd of [
    "",
    // Agrupar no habilita comandos fuera de la allowlist.
    "(Remove-Item lib/a.mjs)",
    "(Invoke-WebRequest https://example.com).Content",
    "git checkout main",
    "git branch -D feat",
    "git push",
    "git -c core.pager=sh log",
    "git diff --output=x.patch main",
    "git diff --ext-diff",
    "git grep -O foo",
    "git diff; rm -rf .",
    "git log | xargs rm",
    "git diff > x.patch",
    "GIT_PAGER=sh git log",
    "npm install",
    "curl https://example.com",
    "node -e 'x'",
    `npx --yes @jpkme/diff-review validate ${out} && rm x`,
    "npx --yes other-pkg validate x.json",
    "sed -i 's/a/b/' lib/a.mjs",
    "sed -n 's/a/b/w out' lib/a.mjs",
    "find . -name '*.js' -delete",
    "find . -exec rm {} ;",
    "sort -o out.txt a.txt",
    "uniq a.txt b.txt",
    "rg --pre sh foo",
    `cat "${home}"`,
    "cat ~/.ssh/id_rsa",
    "cat ../otro/secreto",
    `cd "${join(repo, "..")}" && git diff a...b`,
    "cd && cat .bashrc",
    "Remove-Item lib",
    "Get-ChildItem | ForEach-Object { Remove-Item $_ }",
  ]) {
    assert.equal(ok(cmd), false, cmd);
  }
});

test("checkShell sin repo no acepta cd", () => {
  assert.equal(checkShell(`cd "${repo}" && git diff`).ok, false);
});

test("checkShell permite mkdir bajo .diff-review en el repo", () => {
  assert.equal(ok("mkdir .diff-review"), true);
  assert.equal(ok("mkdir -p .diff-review"), true);
  assert.equal(ok("mkdir .diff-review/tmp"), true);
  assert.equal(ok(`mkdir "${join(repo, ".diff-review")}"`), true);
  assert.equal(ok("mkdir lib"), false);
  assert.equal(ok("mkdir .diff-review other"), false);
  assert.equal(ok("New-Item -ItemType Directory .diff-review"), true);
  assert.equal(ok("New-Item -ItemType Directory lib"), false);
});

test("checkShell entiende paths de Git Bash y WSL en Windows", { skip: !win }, () => {
  assert.equal(ok("cat /c/repos/app/lib/a.mjs"), true);
  assert.equal(ok("cat /c/Users/me/.ssh/id_rsa"), false);
  assert.equal(ok("cd /mnt/c/repos/app && ls -la"), true);
  assert.equal(ok("cat /mnt/c/repos/app/lib/a.mjs"), true);
  assert.equal(ok("cd /mnt/c/Users/me && ls"), false);
  assert.equal(ok("cat /mnt/c/Users/me/.ssh/id_rsa"), false);
});

test("checkShell rechaza symlink dentro del repo que apunta afuera", () => {
  const root = mkdtempSync(join(tmpdir(), "dr-shell-"));
  const outside = mkdtempSync(join(tmpdir(), "dr-shell-out-"));
  writeFileSync(join(outside, "secret.txt"), "secret");
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "lib", "ok.mjs"), "ok");
  const link = join(root, "escape");
  try {
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    if (err && (err.code === "EPERM" || err.code === "EACCES")) return;
    throw err;
  }
  try {
    assert.equal(checkShell(`cat "${join(root, "lib", "ok.mjs")}"`, { repo: root }).ok, true);
    assert.equal(checkShell(`cat "${join(link, "secret.txt")}"`, { repo: root }).ok, false);
    assert.equal(checkShell(`cd "${link}" && ls`, { repo: root }).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
