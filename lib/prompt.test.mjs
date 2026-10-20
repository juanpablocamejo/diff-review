import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildPrompt } from "./prompt.mjs";
import { chatRelPath } from "./output-name.mjs";
import { companionPaths, writeHandoffChat } from "./review-dir.mjs";

const tmp = mkdtempSync(join(tmpdir(), "diff-review-prompt-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("chatRelPath uses same stem as JSON", () => {
  assert.equal(
    chatRelPath("diff-rev_aaaaaaaaaa_bbbbbbbbbb.json"),
    ".diff-review/diff-rev_aaaaaaaaaa_bbbbbbbbbb.chat.md"
  );
});

test("writeHandoffChat overwrites companion .chat.md", () => {
  const filename = "diff-rev_aaaaaaaaaa_bbbbbbbbbb.json";
  writeHandoffChat(tmp, filename, "# first\n");
  writeHandoffChat(tmp, filename, "# second\n");
  const { chat } = companionPaths(tmp, filename);
  assert.equal(readFileSync(chat, "utf8"), "# second\n");
  assert.equal(chatRelPath(filename), `.diff-review/${filename.replace(/\.json$/i, "")}.chat.md`);
});

test("buildPrompt tells agent to preserve finding resolution on rewrite", () => {
  const text = buildPrompt(
    { source: "local", repo: "/tmp/r", branch: "feat", base: "develop" },
    { outputFilename: "diff-rev_aaaaaaaaaa_bbbbbbbbbb.json" }
  );
  assert.match(text, /preserve those fields on rewrite/i);
  assert.match(text, /resolution/);
  assert.match(text, /copy through any per-finding `resolution`/i);
});
