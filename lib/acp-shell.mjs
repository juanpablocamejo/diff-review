/**
 * Qué comandos de terminal puede correr el agente por ACP: git de solo lectura, comandos que solo leen (cat, grep,
 * find, sed -n …, y sus equivalentes de PowerShell) y el validate del paquete. Los paths tienen que quedar dentro
 * del repo.
 *
 * El comando se tokeniza respetando comillas (un `grep "a\|b"` no es un pipe). Se aceptan `|`, `&&`, `||`, `;` y
 * descartar salida a /dev/null; cualquier otra redirección, `$(…)`, backticks o `&` lo rechazan.
 */
import { isAbsolute, normalize, resolve } from "node:path";

/** @typedef {{ ok: true } | { ok: false, reason: string }} ShellCheck */

/** Subcomandos de git que solo leen. */
const GIT_READ = new Set([
  "diff",
  "log",
  "show",
  "status",
  "merge-base",
  "rev-parse",
  "rev-list",
  "blame",
  "ls-files",
  "ls-tree",
  "cat-file",
  "describe",
  "shortlog",
  "name-rev",
  "for-each-ref",
  "grep",
  "whatchanged",
]);

/** Flags de git que ejecutan algo o escriben archivos, en cualquier subcomando. */
const GIT_UNSAFE_FLAG = /^(--output|--ext-diff|-O|--open-files-in-pager)(=|$)/;

const BRANCH_LIST_FLAGS = new Set(["--show-current", "--list", "-a", "--all", "-r", "--remotes", "-v", "-vv"]);
const CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l"]);

/** Comandos que solo leen (o imprimen). Los de PowerShell van en minúscula: no distingue mayúsculas. */
const READ_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "wc",
  "ls",
  "nl",
  "sort",
  "uniq",
  "cut",
  "tr",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "find",
  "sed",
  "file",
  "stat",
  "du",
  "diff",
  "cmp",
  "jq",
  "basename",
  "dirname",
  "realpath",
  "tree",
  "which",
  "type",
  "pwd",
  "echo",
  "printf",
  "true",
  // PowerShell
  "get-content",
  "gc",
  "select-string",
  "sls",
  "get-childitem",
  "gci",
  "dir",
  "measure-object",
  "measure",
  "select-object",
  "select",
  "sort-object",
  "get-location",
  "test-path",
  "resolve-path",
  "write-output",
  "out-string",
  "format-list",
  "format-table",
]);

/** Comandos cuyos argumentos son texto, no paths. */
const TEXT_ARGS = new Set(["echo", "printf", "tr", "write-output", "which", "type"]);

/** Destinos de redirección que solo descartan salida. */
const DISCARD = new Set(["/dev/null", "nul", "$null"]);

/** `/c/Users/...` (Git Bash) → `C:/Users/...` en Windows. */
function toNativePath(p, platform) {
  if (platform === "win32") {
    const msys = /^\/([a-zA-Z])(\/|$)(.*)$/.exec(p);
    if (msys) return `${msys[1].toUpperCase()}:/${msys[3]}`;
  }
  return p;
}

function isInside(child, root, platform) {
  const c = normalize(child).replace(/[\\/]+$/, "");
  const r = normalize(root).replace(/[\\/]+$/, "");
  const [cc, rr] = platform === "win32" ? [c.toLowerCase(), r.toLowerCase()] : [c, r];
  return cc === rr || cc.startsWith(`${rr}\\`) || cc.startsWith(`${rr}/`);
}

/** ¿El argumento parece un path que puede salir del repo? (absoluto, `~` o con `..`). */
function escapingPath(arg) {
  return /^([a-zA-Z]:[\\/]|[\\/]|~)/.test(arg) || /(^|[\\/])\.\.([\\/]|$)/.test(arg);
}

/**
 * Parte el comando en cadenas (separadas por `&&`, `||`, `;`, saltos de línea) de pipelines (`|`) de argv.
 * @param {string} command
 * @returns {{ ok: true, pipelines: string[][][] } | { ok: false, reason: string }}
 */
export function tokenizeShell(command) {
  const src = String(command ?? "");
  /** @type {string[][][]} */
  const pipelines = [];
  /** @type {string[][]} */
  let pipeline = [];
  /** @type {string[]} */
  let words = [];
  let word = "";
  let inWord = false;
  /** @type {null | "'" | '"'} */
  let quote = null;

  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) pipeline.push(words);
    words = [];
  };
  const endPipeline = () => {
    endSegment();
    if (pipeline.length) pipelines.push(pipeline);
    pipeline = [];
  };
  const fail = (reason) => ({ ok: /** @type {const} */ (false), reason });

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "`") return fail("backticks");
      else if (ch === "$" && next === "(") return fail("sustitución $(…)");
      else if (ch === "\\" && next !== undefined && '"\\$`'.includes(next)) {
        word += next;
        i++;
      } else word += ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === "\\" && next !== undefined) {
      word += next;
      inWord = true;
      i++;
      continue;
    }
    if (ch === "`") return fail("backticks");
    if (ch === "$" && next === "(") return fail("sustitución $(…)");
    if (/\s/.test(ch) && ch !== "\n" && ch !== "\r") {
      endWord();
      continue;
    }
    if (ch === "\n" || ch === "\r" || ch === ";") {
      endPipeline();
      continue;
    }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      endPipeline();
      i++;
      continue;
    }
    if (ch === "|") {
      endSegment();
      continue;
    }
    if (ch === ">" || (ch === "&" && next === ">")) {
      // `2>&1`, `2>/dev/null`, `>nul`, `&>/dev/null`: descartar o juntar salidas no escribe nada.
      if (ch === "&") i++;
      const fd = inWord && /^[12]$/.test(word) ? word : "";
      if (inWord && !fd) return fail("redirección");
      word = "";
      inWord = false;
      let j = i + 1;
      if (src[j] === ">") j++;
      if (src[j] === "&" && /[12]/.test(src[j + 1] ?? "")) {
        i = j + 1;
        continue;
      }
      while (src[j] === " " || src[j] === "\t") j++;
      let target = "";
      while (j < src.length && !/[\s;|&<>]/.test(src[j])) target += src[j++];
      if (!DISCARD.has(target.toLowerCase())) return fail(`redirección a ${target || "archivo"}`);
      i = j - 1;
      continue;
    }
    if (ch === "<") return fail("redirección de entrada");
    if (ch === "&") return fail("comando en segundo plano (&)");
    word += ch;
    inWord = true;
  }
  if (quote) return fail("comillas sin cerrar");
  endPipeline();
  return { ok: true, pipelines };
}

/**
 * @param {string} arg
 * @param {{ repo: string, platform: NodeJS.Platform }} ctx
 * @returns {ShellCheck}
 */
function checkPath(arg, { repo, platform }) {
  if (DISCARD.has(arg.toLowerCase())) return { ok: true };
  const native = toNativePath(arg.replace(/^~(?=[\\/]|$)/, "/__home__"), platform);
  const abs = isAbsolute(native) ? native : resolve(repo, native);
  return isInside(abs, repo, platform) ? { ok: true } : { ok: false, reason: `path fuera del repo: ${arg}` };
}

/** Argumentos (y valores de `--opt=valor`) que parecen paths que salen del repo deben quedar adentro. */
function checkArgsInside(args, ctx) {
  for (const arg of args) {
    const value = arg.startsWith("-") ? (arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : "") : arg;
    if (value && escapingPath(value)) {
      const res = checkPath(value, ctx);
      if (!res.ok) return res;
    }
  }
  return { ok: true };
}

/** @param {string[]} argv @returns {ShellCheck} */
function checkGit(argv, ctx) {
  let i = 1;
  while (argv[i]?.startsWith("-")) {
    const flag = argv[i];
    if (flag === "--no-pager" || flag === "-P") i++;
    else if (flag === "-C") {
      const res = checkPath(argv[i + 1] ?? "", ctx);
      if (!res.ok) return res;
      i += 2;
    } else return { ok: false, reason: `opción global de git no permitida: ${flag}` };
  }
  const sub = argv[i] ?? "";
  const rest = argv.slice(i + 1);
  const unsafe = rest.find((w) => GIT_UNSAFE_FLAG.test(w));
  if (unsafe) return { ok: false, reason: `git ${sub} ${unsafe}` };
  if (GIT_READ.has(sub)) return { ok: true };
  if (sub === "branch" && rest.every((w) => BRANCH_LIST_FLAGS.has(w))) return { ok: true };
  if (sub === "remote" && (rest.length === 0 || (rest.length === 1 && rest[0] === "-v") || rest[0] === "get-url"))
    return { ok: true };
  if (sub === "config" && rest.some((w) => CONFIG_READ_FLAGS.has(w))) return { ok: true };
  return { ok: false, reason: `git ${sub || "(sin subcomando)"} no es de solo lectura` };
}

/** @param {string[]} argv @returns {ShellCheck} */
function checkReadCommand(name, argv, ctx) {
  const args = argv.slice(1);
  if (name === "sort" && args.some((a) => /^(-o|--output)/.test(a))) return { ok: false, reason: "sort -o escribe un archivo" };
  if (name === "uniq" && args.filter((a) => !a.startsWith("-")).length > 1)
    return { ok: false, reason: "uniq con archivo de salida" };
  if (name === "find" && args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a)))
    return { ok: false, reason: "find que ejecuta o escribe" };
  if (name === "rg" && args.some((a) => /^--pre(-glob)?(=|$)/.test(a))) return { ok: false, reason: "rg --pre ejecuta comandos" };
  if (name === "sed") {
    if (!args.includes("-n") || args.some((a) => /^(-i|--in-place|-e|-f|--expression|--file)/.test(a)))
      return { ok: false, reason: "sed solo como `sed -n 'N,Mp'`" };
    const script = args.find((a) => !a.startsWith("-"));
    if (!script || !/^\s*(\d+|\$)(\s*,\s*(\d+|\$))?\s*p\s*$/.test(script))
      return { ok: false, reason: "sed solo como `sed -n 'N,Mp'`" };
    return checkArgsInside(args.filter((a) => a !== script), ctx);
  }
  if (TEXT_ARGS.has(name)) return { ok: true };
  return checkArgsInside(args, ctx);
}

/** El validate del paquete (por npx o con el bin instalado), con el archivo como único argumento. */
function isValidate(argv) {
  const line = argv.join(" ");
  return /^(?:npx\s+(?:--yes\s+|-y\s+)?@jpkme\/diff-review(?:@[\w.^~-]+)?|diff-review)\s+validate\s+\S+$/.test(line);
}

/**
 * `mkdir` / `md` / `New-Item -ItemType Directory` solo bajo `.diff-review/` del repo.
 * @param {string[]} argv
 * @param {{ repo: string, platform: NodeJS.Platform }} ctx
 * @returns {ShellCheck | null} null = no es este caso
 */
function checkReviewDirMkdir(argv, ctx) {
  const name = argv[0].toLowerCase();
  const reviewRoot = normalize(resolve(ctx.repo, ".diff-review")).replace(/[\\/]+$/, "");
  /** @param {string} arg */
  const underReviewDir = (arg) => {
    const native = toNativePath(String(arg || "").replace(/^~(?=[\\/]|$)/, "/__home__"), ctx.platform);
    const abs = normalize(isAbsolute(native) ? native : resolve(ctx.repo, native)).replace(/[\\/]+$/, "");
    const [a, r] = ctx.platform === "win32" ? [abs.toLowerCase(), reviewRoot.toLowerCase()] : [abs, reviewRoot];
    return a === r || a.startsWith(`${r}\\`) || a.startsWith(`${r}/`);
  };

  if (name === "mkdir" || name === "md") {
    const paths = argv.slice(1).filter((a) => !a.startsWith("-"));
    if (!paths.length || !paths.every(underReviewDir)) {
      return { ok: false, reason: "mkdir solo permitido bajo .diff-review/" };
    }
    return { ok: true };
  }
  if (name === "new-item") {
    const joined = argv.join(" ").toLowerCase();
    if (!/-itemtype\s+directory\b/.test(joined) && !/\b-type\s+directory\b/.test(joined)) return null;
    const paths = argv.slice(1).filter((a) => !a.startsWith("-") && !/^(directory|file)$/i.test(a));
    if (!paths.length || !paths.every(underReviewDir)) {
      return { ok: false, reason: "New-Item Directory solo permitido bajo .diff-review/" };
    }
    return { ok: true };
  }
  return null;
}

/**
 * @param {string} command
 * @param {{ repo?: string, platform?: NodeJS.Platform }} [opts]
 * @returns {ShellCheck}
 */
export function checkShell(command, { repo, platform = process.platform } = {}) {
  const parsed = tokenizeShell(command);
  if (!parsed.ok) return parsed;
  if (!parsed.pipelines.length) return { ok: false, reason: "comando vacío" };
  const ctx = { repo: repo || process.cwd(), platform };
  for (const pipeline of parsed.pipelines) {
    for (const argv of pipeline) {
      const name = argv[0].toLowerCase();
      if (argv[0].includes("=")) return { ok: false, reason: `variables de entorno en el comando: ${argv[0]}` };
      /** @type {ShellCheck} */
      let res;
      // `cd` solo dentro del repo (sin argumento iría al home).
      if (name === "cd" || name === "set-location")
        res = repo && argv[1] ? checkPath(argv[1], ctx) : { ok: false, reason: "cd fuera del repo" };
      else if (name === "git") res = checkGit(argv, ctx);
      else if (name === "npx" || name === "diff-review") res = isValidate(argv) ? { ok: true } : { ok: false, reason: `${argv.join(" ")}` };
      else if (READ_COMMANDS.has(name)) res = checkReadCommand(name, argv, ctx);
      else {
        const mkdir = checkReviewDirMkdir(argv, ctx);
        res = mkdir ?? { ok: false, reason: `${argv[0]} no está permitido` };
      }
      if (!res.ok) return res;
    }
  }
  return { ok: true };
}
