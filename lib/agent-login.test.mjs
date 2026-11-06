import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authFailureMessage,
  authMethodsFromError,
  canInheritLoginTty,
  classifyAuthMethod,
  claudeCliLoginArgs,
  groupAuthMethods,
  isAuthRequiredError,
  loginCommand,
  looksLikeAuthFailure,
  pickLoginAuthMethod,
  resolveLoginCommand,
  resolveLoginLaunchMode,
  normalizeCopilotLoginHost,
  agentAccountStatus,
  copilotTokenEnvOverrides,
  listGhAuthAccounts,
  logoutCommand,
  logoutGhAuthAccounts,
  withAgentLoginRetry,
  withCopilotLoginHost,
} from "./agent-login.mjs";

describe("classifyAuthMethod", () => {
  it("trata type ausente o agent como agent", () => {
    assert.equal(classifyAuthMethod({ id: "cursor_login" }), "agent");
    assert.equal(classifyAuthMethod({ id: "cursor_login", type: "agent" }), "agent");
  });

  it("trata type terminal como terminal", () => {
    assert.equal(
      classifyAuthMethod({ id: "claude-ai-login", type: "terminal", args: ["--login"] }),
      "terminal"
    );
  });

  it("prioriza _meta.terminal-auth sobre type agent o terminal", () => {
    assert.equal(
      classifyAuthMethod({
        id: "copilot-login",
        name: "Log in with Copilot CLI",
        _meta: {
          "terminal-auth": {
            command: "/opt/homebrew/bin/copilot",
            args: ["login"],
            label: "Copilot Login",
          },
        },
      }),
      "terminal-meta"
    );
    assert.equal(
      classifyAuthMethod({
        id: "claude-ai-login",
        type: "terminal",
        args: ["--cli", "auth", "login", "--claudeai"],
        _meta: {
          "terminal-auth": {
            command: "node",
            args: ["/tmp/adapter.js", "--cli", "auth", "login", "--claudeai"],
            label: "Claude Login",
          },
        },
      }),
      "terminal-meta"
    );
  });

  it("marca unknown si falta id o type raro", () => {
    assert.equal(classifyAuthMethod(null), "unknown");
    assert.equal(classifyAuthMethod({}), "unknown");
    assert.equal(classifyAuthMethod({ id: "x", type: "oauth" }), "unknown");
  });
});

describe("groupAuthMethods", () => {
  it("separa agent, terminal y terminal-meta", () => {
    const grouped = groupAuthMethods([
      { id: "cursor_login" },
      { id: "claude-ai-login", type: "terminal", args: ["a"] },
      {
        id: "copilot-login",
        _meta: { "terminal-auth": { command: "copilot", args: ["login"] } },
      },
    ]);
    assert.deepEqual(
      grouped.agent.map((m) => m.id),
      ["cursor_login"]
    );
    assert.deepEqual(
      grouped.terminal.map((m) => m.id),
      ["claude-ai-login"]
    );
    assert.deepEqual(
      grouped.terminalMeta.map((m) => m.id),
      ["copilot-login"]
    );
  });
});

describe("loginCommand", () => {
  it("usa el CLI real de cada agente (claude sin --cli del adapter)", () => {
    assert.deepEqual(loginCommand("claude"), {
      bin: "claude",
      args: ["auth", "login"],
      display: "claude auth login",
    });
    assert.deepEqual(loginCommand("copilot"), {
      bin: "copilot",
      args: ["login"],
      display: "copilot login",
    });
    assert.deepEqual(loginCommand("cursor"), {
      bin: "cursor-agent",
      args: ["login"],
      display: "cursor-agent login",
    });
    assert.equal(loginCommand("other"), null);
  });

  it("Copilot acepta host Enterprise opcional (elección del usuario)", () => {
    assert.deepEqual(loginCommand("copilot", { host: "acme.ghe.com" }), {
      bin: "copilot",
      args: ["login", "--host", "acme.ghe.com"],
      display: "copilot login --host acme.ghe.com",
    });
    assert.deepEqual(loginCommand("copilot", { host: "github.com" }).args, ["login"]);
  });
});

describe("withCopilotLoginHost", () => {
  it("normaliza y agrega --host; github.com queda sin flag", () => {
    assert.equal(normalizeCopilotLoginHost("https://acme.ghe.com/foo"), "acme.ghe.com");
    assert.equal(normalizeCopilotLoginHost("github.com"), "");
    const base = { bin: "copilot", args: ["login"], display: "copilot login" };
    assert.deepEqual(withCopilotLoginHost(base, "").args, ["login"]);
    assert.deepEqual(withCopilotLoginHost(base, "acme.ghe.com").args, [
      "login",
      "--host",
      "acme.ghe.com",
    ]);
  });
});

describe("copilot / gh logout helpers", () => {
  it("detecta env overrides de token", () => {
    assert.deepEqual(copilotTokenEnvOverrides({}), []);
    assert.deepEqual(copilotTokenEnvOverrides({ GH_TOKEN: "x", FOO: "1" }), ["GH_TOKEN"]);
  });

  it("lista cuentas gh desde JSON", () => {
    const accounts = listGhAuthAccounts({
      run: () => ({
        status: 0,
        stdout: JSON.stringify({
          hosts: {
            "github.com": [
              { login: "personal", active: true },
              { login: "corp", active: false },
            ],
          },
        }),
        stderr: "",
        error: undefined,
      }),
    });
    assert.deepEqual(accounts, [
      { host: "github.com", user: "personal", active: true },
      { host: "github.com", user: "corp", active: false },
    ]);
  });

  it("logoutGhAuthAccounts llama gh auth logout por cuenta", () => {
    /** @type {string[][]} */
    const calls = [];
    const result = logoutGhAuthAccounts({
      env: {},
      run: (bin, args) => {
        if (args?.[0] === "auth" && args?.[1] === "status") {
          return {
            status: 0,
            stdout: JSON.stringify({
              hosts: { "github.com": [{ login: "personal", active: true }] },
            }),
            stderr: "",
            error: undefined,
          };
        }
        calls.push([bin, ...(args || [])]);
        return { status: 0, stdout: "", stderr: "", error: undefined };
      },
    });
    assert.equal(result.loggedOut.length, 1);
    assert.deepEqual(calls[0], [
      "gh",
      "auth",
      "logout",
      "--hostname",
      "github.com",
      "--user",
      "personal",
    ]);
  });

  it("logoutCommand solo para claude", () => {
    assert.deepEqual(logoutCommand("claude")?.args, ["auth", "logout"]);
    assert.equal(logoutCommand("copilot"), null);
  });

  it("agentAccountStatus lee cuenta activa de gh para Copilot", () => {
    const status = agentAccountStatus("copilot", {
      env: {},
      run: () => ({
        status: 0,
        stdout: JSON.stringify({
          hosts: { "github.com": [{ login: "corp-user", active: true }] },
        }),
        stderr: "",
        error: undefined,
      }),
    });
    assert.equal(status.loggedIn, true);
    assert.equal(status.accountLabel, "corp-user");
    assert.equal(status.source, "gh");
  });
});

describe("claudeCliLoginArgs", () => {
  it("saca --cli y conserva auth login + flags del método", () => {
    assert.deepEqual(
      claudeCliLoginArgs({
        id: "claude-ai-login",
        type: "terminal",
        args: ["--cli", "auth", "login", "--claudeai"],
      }),
      ["auth", "login", "--claudeai"]
    );
    assert.deepEqual(
      claudeCliLoginArgs({
        id: "console-login",
        type: "terminal",
        args: ["--cli", "auth", "login", "--console"],
        _meta: {
          "terminal-auth": {
            command: "node",
            args: ["/x/adapter.js", "--cli", "auth", "login", "--console"],
          },
        },
      }),
      ["auth", "login", "--console"]
    );
    assert.deepEqual(claudeCliLoginArgs(null), ["auth", "login"]);
  });
});

describe("looksLikeAuthFailure / authFailureMessage", () => {
  it("detecta fallos de auth típicos", () => {
    assert.equal(looksLikeAuthFailure("Authentication required"), true);
    assert.equal(looksLikeAuthFailure("auth_required"), true);
    assert.equal(looksLikeAuthFailure("not logged in"), true);
    assert.equal(looksLikeAuthFailure("ENOENT"), false);
  });

  it("arma mensaje en español sin comando CLI", () => {
    const msg = authFailureMessage("copilot", "GitHub Copilot CLI", "Authentication required");
    assert.match(msg, /Necesitás iniciar sesión en GitHub Copilot CLI/);
    assert.equal(/copilot login/.test(msg || ""), false);
    assert.equal(authFailureMessage("copilot", "Copilot", "random crash"), null);
  });
});

describe("resolveLoginCommand", () => {
  const agent = {
    def: {
      id: "copilot",
      acp: ({ path }) => ({ file: path, args: ["--acp"] }),
    },
    path: "copilot",
  };

  it("usa command/args de _meta.terminal-auth", () => {
    const cmd = resolveLoginCommand(agent, {
      id: "copilot-login",
      _meta: {
        "terminal-auth": {
          command: "/usr/bin/copilot",
          args: ["login"],
          label: "Copilot Login",
        },
      },
    });
    assert.equal(cmd.bin, "/usr/bin/copilot");
    assert.deepEqual(cmd.args, ["login"]);
    assert.equal(cmd.display, "Copilot Login");
  });

  it("para Claude type terminal usa el binario claude, no npx/adapter", () => {
    const claude = {
      def: {
        id: "claude",
        acp: () => ({ file: "npx", args: ["--yes", "pkg"] }),
      },
      path: "/usr/bin/claude",
    };
    const cmd = resolveLoginCommand(claude, {
      id: "claude-ai-login",
      type: "terminal",
      args: ["--cli", "auth", "login", "--claudeai"],
    });
    assert.equal(cmd.bin, "/usr/bin/claude");
    assert.deepEqual(cmd.args, ["auth", "login", "--claudeai"]);
    assert.equal(cmd.display, "claude auth login --claudeai");
  });

  it("para Claude con _meta.terminal-auth del adapter igual prefiere claude CLI", () => {
    const claude = {
      def: { id: "claude", acp: () => ({ file: "npx", args: ["--yes", "pkg"] }) },
      path: "C:\\\\Users\\\\me\\\\claude.exe",
    };
    const cmd = resolveLoginCommand(claude, {
      id: "claude-ai-login",
      type: "terminal",
      args: ["--cli", "auth", "login", "--claudeai"],
      _meta: {
        "terminal-auth": {
          command: "C:\\\\Program Files\\\\nodejs\\\\node.exe",
          args: [
            "C:\\\\npm\\\\claude-agent-acp\\\\dist\\\\index.js",
            "--cli",
            "auth",
            "login",
            "--claudeai",
          ],
          label: "Claude Login",
        },
      },
    });
    assert.equal(cmd.bin, "C:\\\\Users\\\\me\\\\claude.exe");
    assert.deepEqual(cmd.args, ["auth", "login", "--claudeai"]);
  });

  it("para type terminal sin meta (no Claude) usa launch ACP + args del método", () => {
    const other = {
      def: {
        id: "other-agent",
        acp: () => ({ file: "npx", args: ["--yes", "pkg"] }),
      },
      path: "other",
    };
    const cmd = resolveLoginCommand(other, {
      id: "login",
      type: "terminal",
      args: ["--login"],
    });
    assert.equal(cmd.bin, "npx");
    assert.deepEqual(cmd.args, ["--yes", "pkg", "--login"]);
  });

  it("cae al loginCommand del agente si no hay método", () => {
    const cmd = resolveLoginCommand(agent, null);
    assert.equal(cmd.display, "copilot login");
  });

  it("fallback Claude usa agent.path sin --cli", () => {
    const claude = { def: { id: "claude" }, path: "/opt/claude" };
    const cmd = resolveLoginCommand(claude, null);
    assert.equal(cmd.bin, "/opt/claude");
    assert.deepEqual(cmd.args, ["auth", "login"]);
  });
});

describe("isAuthRequiredError / authMethodsFromError / pickLoginAuthMethod", () => {
  it("detecta AcpAuthRequiredError por name", () => {
    const err = Object.assign(new Error("Copilot requiere autenticación"), {
      name: "AcpAuthRequiredError",
      methods: [{ id: "copilot-login", _meta: { "terminal-auth": { command: "copilot", args: ["login"] } } }],
    });
    assert.equal(isAuthRequiredError(err), true);
    assert.equal(authMethodsFromError(err).length, 1);
  });

  it("detecta texto de auth sin clase especial", () => {
    assert.equal(isAuthRequiredError(new Error("not logged in")), true);
    assert.equal(isAuthRequiredError(new Error("ENOENT")), false);
    assert.equal(authMethodsFromError(new Error("x")).length, 0);
  });

  it("elige terminal-meta antes que terminal; null si solo agent", () => {
    assert.equal(
      pickLoginAuthMethod([
        { id: "cursor_login" },
        { id: "claude", type: "terminal" },
        { id: "copilot-login", _meta: { "terminal-auth": { command: "copilot", args: ["login"] } } },
      ])?.id,
      "copilot-login"
    );
    assert.equal(pickLoginAuthMethod([{ id: "claude", type: "terminal" }])?.id, "claude");
    assert.equal(pickLoginAuthMethod([{ id: "cursor_login" }]), null);
    assert.equal(pickLoginAuthMethod([]), null);
  });
});

describe("canInheritLoginTty", () => {
  it("respeta external: true aunque haya TTY", () => {
    assert.equal(canInheritLoginTty({ external: true }), false);
  });
});

describe("resolveLoginLaunchMode", () => {
  it("con wait y external: true fuerza external (no inherit)", () => {
    assert.equal(resolveLoginLaunchMode({ wait: true, external: true }), "external");
  });

  it("sin wait ni external usa hidden (web / OAuth sin ventana)", () => {
    assert.equal(resolveLoginLaunchMode({}), "hidden");
    assert.equal(resolveLoginLaunchMode({ wait: false }), "hidden");
  });

  it("con wait y sin external: inherit si hay TTY, si no hidden", () => {
    const mode = resolveLoginLaunchMode({ wait: true });
    const hasTty = Boolean(process.stdin?.isTTY && process.stdout?.isTTY);
    assert.equal(mode, hasTty ? "inherit" : "hidden");
  });
});

describe("withAgentLoginRetry", () => {
  const agent = {
    def: { id: "copilot", label: "GitHub Copilot CLI" },
    path: "copilot",
  };

  it("devuelve value si op ok", async () => {
    const out = await withAgentLoginRetry(async () => 42, {
      agent,
      askToLogin: async () => {
        throw new Error("no debería preguntar");
      },
    });
    assert.deepEqual(out, { ok: true, value: 42 });
  });

  it("cancela sin lanzar login si el usuario dice no", async () => {
    const err = Object.assign(new Error("Authentication required"), {
      name: "AcpAuthRequiredError",
      methods: [],
    });
    let ranTerminal = false;
    const out = await withAgentLoginRetry(async () => {
      throw new Error("no retry");
    }, {
      agent,
      priorError: err,
      askToLogin: async ({ displayCmd }) => {
        assert.match(displayCmd, /copilot login/);
        return false;
      },
      runTerminal: async () => {
        ranTerminal = true;
        return { display: "x", code: 0, mode: "hidden" };
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.cancelled, true);
    assert.equal(ranTerminal, false);
  });

  it("abre login, espera exit 0 y reintenta op", async () => {
    const err = Object.assign(new Error("Authentication required"), {
      name: "AcpAuthRequiredError",
      methods: [
        {
          id: "copilot-login",
          _meta: { "terminal-auth": { command: "copilot", args: ["login"], label: "Copilot Login" } },
        },
      ],
    });
    let attempts = 0;
    /** @type {string[]} */
    const statuses = [];
    const out = await withAgentLoginRetry(async () => {
      attempts += 1;
      return "models";
    }, {
      agent,
      priorError: err,
      askToLogin: async () => true,
      onStatus: (msg) => statuses.push(msg),
      runTerminal: async (cmd) => {
        assert.equal(cmd.display, "Copilot Login");
        return { display: cmd.display, code: 0, mode: "inherit" };
      },
    });
    assert.deepEqual(out, { ok: true, value: "models" });
    assert.equal(attempts, 1);
    assert.ok(statuses.some((s) => /Esperando que completes el inicio de sesión/.test(s)));
    assert.ok(statuses.some((s) => /Login ok/.test(s)));
  });

  it("no dice Login ok si el exit code no es 0", async () => {
    const err = Object.assign(new Error("Authentication required"), {
      name: "AcpAuthRequiredError",
      methods: [],
    });
    /** @type {string[]} */
    const statuses = [];
    const out = await withAgentLoginRetry(async () => {
      throw new Error("no debería reintentar");
    }, {
      agent,
      priorError: err,
      askToLogin: async () => true,
      onStatus: (msg) => statuses.push(msg),
      runTerminal: async () => ({ display: "copilot login", code: 1, mode: "inherit" }),
    });
    assert.equal(out.ok, false);
    assert.equal(out.cancelled, false);
    assert.match(
      String(/** @type {{ error: Error }} */ (out).error.message),
      /No se pudo completar el inicio de sesión/
    );
    assert.equal(statuses.some((s) => /Login ok/.test(s)), false);
  });

  it("no ofrece login si el error no es de auth", async () => {
    const out = await withAgentLoginRetry(async () => {
      throw new Error("boom");
    }, {
      agent,
      askToLogin: async () => true,
      runTerminal: async () => ({ display: "x", code: 0, mode: "hidden" }),
    });
    assert.equal(out.ok, false);
    assert.equal(out.cancelled, false);
    assert.match(String(/** @type {{ error: Error }} */ (out).error.message), /boom/);
  });
});
