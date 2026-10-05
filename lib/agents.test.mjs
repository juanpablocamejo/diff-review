import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AGENT_DEFAULT_MODEL,
  AGENTS,
  detectAgents,
  findOnPath,
  modelChoices,
  OTHER_MODEL,
  topLevelTomlModel,
} from "./agents.mjs";

const claude = AGENTS.find((a) => a.id === "claude");
const codex = AGENTS.find((a) => a.id === "codex");

function sandbox() {
  return mkdtempSync(join(tmpdir(), "diff-review-agents-"));
}

function touch(file, content = "") {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content, { mode: 0o755 });
  return file;
}

describe("findOnPath", () => {
  it("en Windows prueba las extensiones de PATHEXT (shims .cmd de npm)", () => {
    const root = sandbox();
    const bin = join(root, "npm");
    touch(join(bin, "codex.cmd"));
    const found = findOnPath("codex", {
      env: { PATH: `${join(root, "nada")};${bin}`, PATHEXT: ".EXE;.CMD" },
      platform: "win32",
    });
    assert.equal(found, join(bin, "codex.cmd"));
  });

  it("devuelve null si no está", () => {
    assert.equal(findOnPath("codex", { env: { PATH: sandbox() }, platform: "linux" }), null);
  });
});

describe("detectAgents", () => {
  it("encuentra el Claude Code de la app de escritorio de Windows, en su versión más nueva", () => {
    const home = sandbox();
    const appData = join(home, "AppData", "Roaming");
    const root = join(appData, "Claude", "claude-code");
    touch(join(root, "2.1.9", "aaa", "claude.exe"));
    const newest = touch(join(root, "2.1.286", "bbb", "claude.exe"));
    const found = detectAgents({ env: { PATH: "", APPDATA: appData }, platform: "win32", home });
    assert.deepEqual(
      found.map((a) => [a.def.id, a.path]),
      [["claude", newest]]
    );
  });

  it("el PATH gana sobre las rutas fijas", () => {
    const home = sandbox();
    const appData = join(home, "AppData", "Roaming");
    touch(join(appData, "Claude", "claude-code", "2.1.286", "bbb", "claude.exe"));
    const onPath = touch(join(home, "bin", "claude.exe"));
    const found = detectAgents({
      env: { PATH: join(home, "bin"), PATHEXT: ".EXE", APPDATA: appData },
      platform: "win32",
      home,
    });
    assert.equal(found[0].path, onPath);
  });

  it("sin nada instalado devuelve vacío", () => {
    assert.deepEqual(detectAgents({ env: { PATH: "" }, platform: "linux", home: sandbox() }), []);
  });
});

describe("modelChoices", () => {
  it("sin modelo configurado: 'Por defecto del agente' primero y como inicial, y 'Otro…' al final", () => {
    const { options, initialValue } = modelChoices(claude, { env: {}, platform: "linux", home: sandbox() });
    assert.equal(initialValue, AGENT_DEFAULT_MODEL);
    assert.equal(options[0].value, AGENT_DEFAULT_MODEL);
    assert.equal(options[0].label, "Por defecto del agente");
    assert.deepEqual(
      options.slice(1, -1).map((o) => o.value),
      ["opus", "sonnet", "haiku"]
    );
    assert.equal(options.at(-1).value, OTHER_MODEL);
  });

  it("muestra el modelo configurado en ~/.claude/settings.json y no lo repite en la lista", () => {
    const home = sandbox();
    touch(join(home, ".claude", "settings.json"), JSON.stringify({ model: "sonnet" }));
    const { options } = modelChoices(claude, { env: {}, platform: "linux", home });
    assert.equal(options[0].label, "Por defecto (sonnet)");
    assert.equal(options[0].hint, "~/.claude/settings.json");
    assert.ok(!options.slice(1).some((o) => o.value === "sonnet"));
  });

  it("ANTHROPIC_MODEL pisa a settings.json", () => {
    const { options } = modelChoices(claude, {
      env: { ANTHROPIC_MODEL: "opus" },
      platform: "linux",
      home: sandbox(),
    });
    assert.equal(options[0].label, "Por defecto (opus)");
  });

  it("codex lee el model de nivel raíz de ~/.codex/config.toml", () => {
    const home = sandbox();
    touch(join(home, ".codex", "config.toml"), 'model = "gpt-x"\n[profiles.otro]\nmodel = "nope"\n');
    const { options } = modelChoices(codex, { env: {}, platform: "linux", home });
    assert.equal(options[0].label, "Por defecto (gpt-x)");
  });
});

describe("topLevelTomlModel", () => {
  it("ignora los model dentro de secciones", () => {
    assert.equal(topLevelTomlModel('[profiles.a]\nmodel = "x"\n'), null);
    assert.equal(topLevelTomlModel('approval = "never"\nmodel = \'y\'\n'), "y");
  });
});

describe("args", () => {
  it("claude: -p, --model solo si se eligió uno, y escritura limitada al JSON del review", () => {
    const args = claude.args({ model: "opus", outputFilename: "diff-rev_a_b.json" });
    assert.deepEqual(args.slice(0, 3), ["-p", "--model", "opus"]);
    assert.ok(args.includes("Edit(./diff-rev_a_b.json)"));
    assert.ok(!claude.args({ outputFilename: "x.json" }).includes("--model"));
  });

  it("codex: lee el prompt de stdin", () => {
    assert.equal(codex.args({ outputFilename: "x.json" }).at(-1), "-");
  });
});
