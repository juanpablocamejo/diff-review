/**
 * Espera a que aparezca un JSON de review válido en el repo.
 */
import { existsSync, readFileSync, watch } from "node:fs";
import { basename, join } from "node:path";
import { decodePayload } from "./json-payload.mjs";
import { REVIEW_SCHEMA, validateAgainst } from "./validate.mjs";

/**
 * @param {string} repoRoot
 * @param {string} filename
 * @param {{ onInvalid?: (errors: string[]) => void, pollMs?: number }} [opts]
 * @returns {Promise<{ path: string, payload: unknown }>}
 */
export function waitForReviewOutput(repoRoot, filename, opts = {}) {
  const target = join(repoRoot, filename);
  const name = basename(filename);
  const pollMs = opts.pollMs ?? 800;
  let lastInvalidKey = "";

  const tryRead = () => {
    if (!existsSync(target)) return null;
    let text;
    try {
      text = readFileSync(target, "utf8");
    } catch {
      return null;
    }
    if (!text.trim()) return null;
    let payload;
    try {
      payload = decodePayload(text);
    } catch {
      return null;
    }
    const errors = validateAgainst(REVIEW_SCHEMA, payload);
    if (errors.length) {
      const key = errors.join("\n");
      if (key !== lastInvalidKey) {
        lastInvalidKey = key;
        opts.onInvalid?.(errors);
      }
      return null;
    }
    return { path: target, payload };
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {import('node:fs').FSWatcher | null} */
    let watcher = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
      reject(err);
    };

    const tick = () => {
      try {
        const hit = tryRead();
        if (hit) finish(hit);
      } catch (err) {
        fail(err);
      }
    };

    tick();
    if (settled) return;

    try {
      watcher = watch(repoRoot, { persistent: true }, (_event, changed) => {
        if (!changed || String(changed) === name || String(changed).endsWith(name)) tick();
      });
      watcher.on("error", () => {
        /* poll sigue */
      });
    } catch {
      /* solo poll */
    }

    timer = setInterval(tick, pollMs);
  });
}
