import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePayload } from "./json-payload.mjs";

test("decodePayload parses raw JSON", () => {
  assert.deepEqual(decodePayload('{"intent":"hola mundo largo para cumplir minimo"}'), {
    intent: "hola mundo largo para cumplir minimo",
  });
});

test("decodePayload parses fenced JSON", () => {
  assert.deepEqual(decodePayload('```json\n{"intent":"ok"}\n```'), { intent: "ok" });
});

test("decodePayload rescues JSON with prose around", () => {
  assert.deepEqual(decodePayload("Here:\n{\"intent\":\"x\"}\nDone."), { intent: "x" });
});

test("decodePayload fails on garbage", () => {
  assert.throws(() => decodePayload(""), /vacía/);
  assert.throws(() => decodePayload("no json here"), /JSON/i);
});
