import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAcpModelSelectOptions,
  compactModelMeta,
  formatModelOption,
  humanizeModelId,
  modelOptionLabel,
} from "./model-label.mjs";

test("humanizeModelId", () => {
  assert.equal(humanizeModelId("claude-opus-5-5"), "Claude Opus 5.5");
  assert.equal(humanizeModelId("claude-sonnet-5.5"), "Claude Sonnet 5.5");
  assert.equal(humanizeModelId("gemini-3.8-flash"), "Gemini 3.8 Flash");
  assert.equal(humanizeModelId("gpt-5.6-sol"), "GPT 5.6 Sol");
});

test("compactModelMeta", () => {
  assert.deepEqual(compactModelMeta("context=300k,effort=medium,fast=false"), ["300k", "medium"]);
  assert.deepEqual(compactModelMeta("thinking=true,context=300k,effort=high,fast=false"), [
    "thinking",
    "300k",
    "high",
  ]);
  assert.deepEqual(compactModelMeta("1m"), ["1m"]);
});

test("formatModelOption compacto y amigable", () => {
  const a = formatModelOption("claude-opus-5-5", "claude-opus-5-5[context=300k,effort=medium,fast=false]");
  assert.equal(a.title, "Claude Opus 5.5");
  assert.deepEqual(a.badges, ["300k", "medium"]);
  assert.equal(a.label, "Claude Opus 5.5  ·  [ 300k, medium ]");
  assert.equal(a.hint, "[ 300k, medium ]");

  const b = formatModelOption("Claude Sonnet 5.5", "claude-sonnet-5.5");
  assert.equal(b.title, "Claude Sonnet 5.5");
  assert.deepEqual(b.badges, []);
  assert.equal(b.label, "Claude Sonnet 5.5");

  const c = formatModelOption("Sonnet (1M context)", "sonnet[1m]");
  assert.equal(c.title, "Sonnet (1M context)");
  assert.deepEqual(c.badges, []);
});

test("buildAcpModelSelectOptions fusiona aliases y formatea ACP", () => {
  const { options } = buildAcpModelSelectOptions(
    {
      currentModel: "default",
      models: [
        { value: "default", name: "Default (recommended)" },
        {
          value: "claude-opus-5-5[context=300k,effort=medium,fast=false]",
          name: "claude-opus-5-5",
        },
      ],
    },
    {
      options: [
        { value: "", label: "Por defecto (opus)" },
        { value: "opus", label: "opus", hint: "el más capaz" },
      ],
    }
  );
  assert.equal(options[0].label, "Por defecto (opus)");
  assert.ok(options.some((o) => o.value === "opus"));
  const opusAcp = options.find((o) => o.value.startsWith("claude-opus-5-5"));
  assert.equal(opusAcp?.title, "Claude Opus 5.5");
  assert.deepEqual(opusAcp?.badges, ["300k", "medium"]);
  assert.equal(opusAcp?.hint, "[ 300k, medium ]");
});

test("modelOptionLabel compat", () => {
  assert.equal(
    modelOptionLabel("grok-4.7", "grok-4.7[context=256k,fast=true]"),
    "Grok 4.7  ·  [ 256k, fast ]"
  );
});
