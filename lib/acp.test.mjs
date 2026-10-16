import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENTS } from "./agents.mjs";
import { modelConfig, supportsAcp } from "./acp.mjs";

// Lo que devuelve claude-agent-acp en `session/new` (recortado).
const claudeSession = {
  sessionId: "s-1",
  configOptions: [
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "Default (recommended)" },
        { value: "opus", name: "Opus" },
        { value: "haiku", name: "Haiku" },
      ],
    },
  ],
};

test("modelConfig lee la opción de modelo de session/new", () => {
  assert.deepEqual(modelConfig(claudeSession), {
    configId: "model",
    current: "default",
    options: [
      { value: "default", name: "Default (recommended)" },
      { value: "opus", name: "Opus" },
      { value: "haiku", name: "Haiku" },
    ],
  });
});

test("modelConfig aplana grupos de opciones y tolera agentes sin modelo", () => {
  const grouped = {
    configOptions: [
      { id: "m", category: "model", type: "select", currentValue: "a", options: [{ group: "g", name: "G", options: [{ value: "a", name: "A" }] }] },
    ],
  };
  assert.deepEqual(modelConfig(grouped)?.options, [{ value: "a", name: "A" }]);
  assert.equal(modelConfig({ configOptions: [] }), null);
  assert.equal(modelConfig({}), null);
});

test("supportsAcp: Claude Code tiene modo ACP", () => {
  const claude = AGENTS.find((a) => a.id === "claude");
  assert.equal(supportsAcp({ def: claude, path: "claude" }), true);
  assert.equal(supportsAcp({ def: { ...claude, acp: undefined }, path: "claude" }), false);
});

test("modelConfig no repite modelos con el mismo valor", () => {
  const dup = { configOptions: [{ id: "model", type: "select", currentValue: "auto", options: [{ value: "auto", name: "Auto" }, { value: "auto", name: "Auto" }, { value: "x", name: "X" }] }] };
  assert.deepEqual(modelConfig(dup)?.options.map((o) => o.value), ["auto", "x"]);
});
