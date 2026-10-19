# diff-review

App local para revisar un branch con tu agente (Claude, Cursor, Copilot, etc.):
lanzás la review desde la UI o la CLI, el agente escribe el JSON, la UI completa
los diffs con `git` y te deja triager hallazgos. Por ACP ves el proceso en vivo y
después podés preguntarle o pedirle cambios al reporte desde la web. También podés
copiar el prompt y correrlo en otro agente a mano.

## Instalación

Requiere **Node ≥ 20** y **git** en el PATH. En Windows/macOS/Linux x64 el diálogo
de carpeta usa `@bindrs/rfd` (nativo); si el addon no está para tu plataforma, hay fallback.

```bash
npm install -g @jpkme/diff-review
diff-review
```

O sin instalar:

```bash
npx @jpkme/diff-review
```

### Modos

Desde un **repo git**, el default es terminal-first:

1. Elegís **branch** y **base** con prompts en la terminal (`@clack/prompts`; tipeá para filtrar).
2. Si hay agentes instalados, el default es lanzar uno (ACP en la web cuando aplica); también podés copiar el prompt al portapapeles.
3. El agente escribe `diff-rev_{branchTip}_{baseTip}.json`; la CLI valida y abre el viewer.

Si pasás `--branch` y `--base` juntos, saltea los selects. Si quedan iguales (diff vacío), abre la UI.

Si ya hay un JSON válido para esos mismos commits, pregunta si abrir el existente o generarlo de nuevo; en ese
caso el archivo viejo no cuenta hasta que el agente lo reescriba. Sin terminal interactiva no pregunta: con
`--agent` lo genera de nuevo y sin `--agent` abre el existente.

### Lanzar el agente (`--agent`)

Si hay agentes instalados, después de branch y base un solo select lista cada agente detectado (default el primero)
y, al final, copiar el prompt al portapapeles. Con `--agent` saltea esa lista y va directo a elegir agente y modelo:

```bash
diff-review --agent
```

Al enviarlo a un agente, en vez de copiar el prompt pregunta el modelo (con `--agent`, primero el agente):

1. **Agente**: los instalados que encuentra (Claude Code, Codex, Cursor CLI, GitHub Copilot CLI, Gemini CLI). Si ya lo elegiste en la lista anterior, este paso no se repite. Se buscan por nombre en el `PATH` y en algunas rutas fijas: en Windows, el Claude Code que trae la app de
   escritorio (`%APPDATA%\Claude\claude-code\<versión>\…\claude.exe`) y `%LOCALAPPDATA%\cursor-agent\cursor-agent.cmd`;
   en Linux/macOS, `~/.local/bin/claude`, `~/.claude/local/claude` y `~/.local/bin/cursor-agent`.
2. **Modelo**: arranca en el default del agente (el configurado en `~/.claude/settings.json` /
   `ANTHROPIC_MODEL`, `~/.codex/config.toml`, `~/.cursor/cli-config.json`, `~/.copilot/settings.json` o
   `~/.gemini/settings.json`; si no hay, no se pasa `--model`). También lista los conocidos (para Claude, los
   alias `opus` / `sonnet` / `haiku`; para Copilot, `auto`) y "Otro…" para escribir un id.

El prompt viaja por stdin y la salida del agente se ve en la terminal. Claude Code y Copilot corren con permisos
acotados: leer, `git`, el `validate` y escribir solo el JSON del review (Copilot no puede acotar por argumentos,
así que permite `npx` en general). Cursor corre con `--force` (no tiene
flag para pasar una allowlist y sin él bloquearía el `validate`) y Gemini con `--yolo`. Si no hay agentes
instalados, sigue con el portapapeles. Sin terminal interactiva usa el primer agente con su modelo por defecto.

El agente tiene que estar logueado (p. ej. `claude /login` una vez).

#### Por ACP, con la web (Claude Code, Cursor CLI, GitHub Copilot CLI)

Si el agente elegido habla ACP, la CLI abre la UI enseguida y el agente corre dentro del server local. Claude Code
va por el adaptador `@agentclientprotocol/claude-agent-acp` (se baja con `npx` la primera vez); Cursor
(`cursor-agent acp`) y Copilot (`copilot --acp`) lo traen de fábrica. Codex y Gemini siguen por la terminal.

- El select de modelo muestra los que ofrece cada agente (se consultan por ACP la primera vez).
- La web muestra lo que va haciendo (comandos, archivos que lee, plan). La terminal solo avisa fallos duros o JSON válido.
- Al terminar cada turno, el server valida el JSON; si falta algo se lo pide al agente hasta dos veces y, cuando valida,
  la web abre el reporte.
- Cada pedido de permiso pasa por una política fija: leer dentro del repo, escribir únicamente el JSON del review
  y comandos de solo lectura: `git` (diff, log, show, blame…), `cat`, `head`, `tail`, `grep`, `rg`, `find`, `ls`,
  `wc`, `sed -n 'N,Mp'` y sus equivalentes de PowerShell, encadenados con `|`, `&&`, `||` o `;`, con los paths
  dentro del repo. Se rechazan redirecciones a archivos (salvo `/dev/null`), `$(…)`, red, instalaciones y todo lo
  demás; el agente recibe las reglas en el prompt para no intentarlo.
- La allowlist propia de cada agente no se usa en estas sesiones (aprobaría por nombre de comando, p. ej.
  `echo x > archivo`): Claude corre sin cargar `~/.claude/settings.json` ni el `.claude/` del repo, y Cursor con
  una copia de su configuración sin `permissions.allow` (en el temp del sistema; el login se conserva).
- La sesión queda viva: en el reporte, el botón **Agente** abre un chat para preguntarle sobre la review
  (no puede escribir nada) o pedirle cambios al JSON (el reporte se actualiza y el triage de los hallazgos que
  siguen se conserva). Si el server se reinició, la sesión se retoma con `session/load`.

También se puede lanzar desde la UI, en "2. Generar review" → **Lanzar agente**. Con `--headless` corre en la
terminal como el resto de los agentes.

Para abrir la UI primero (sin esperar el JSON):

```bash
diff-review --ui
```

Opciones: `--port` (si está ocupado, usa el siguiente libre), `--host`, `--base`, `--branch`, `--agent`, `--headless`, `--no-open`.

Si lo lanzás desde un repositorio git, la UI precarga esa ruta y el branch actual.

## Desarrollo (desde el repo)

```bash
npm run web:install
npm run web:dev          # UI en modo dev
npm run build            # build de producción → web/build
npm start                # mismo que el bin global
```

## Flujo (UI)

1. Pegá la ruta (o URL) del repo y elegí branch / base — o lanzá `diff-review` / `diff-review --ui` desde el repo.
2. Si hay agentes ACP, el default es **Lanzar agente**; si no, usá **Copiar prompt** y pegalo en tu agente.
3. El agente escribe `.diff-review/diff-rev_{branchTip}_{baseTip}.json` (en sesiones ACP el server valida solo; si corriste el prompt a mano, `npx --yes @jpkme/diff-review validate <archivo>`).
4. Con agente integrado o CLI el reporte se abre solo; si no, arrastrá el JSON a la dropzone. La UI hidrata los diffs con git (reusa el companion `.diff` si existe).

## Qué hace git (en tu máquina)

Al abrir un reporte, el backend local corre `git` contra el repo que indicaste
para armar los diffs y, si pedís contexto faltante, leer el archivo en la punta
del branch. Por eso corre en localhost, no como SaaS.

Los reportes y el triage viven en **localStorage** del navegador.

## Qué se reporta y qué no

Los hallazgos tienen dos ejes. `class=risk` es lo que puede romper en producción
o al mergear, y solo eso puede marcar `blocking`. `class=quality` son mejoras
reales de mantenibilidad y nunca frenan un merge.

No se reporta lo que ya cazan el linter, el typechecker, el formatter o el CI,
ni preferencias de estilo sin consecuencia, ni "falta documentación" sin un
escenario concreto que se rompa.

## Configuración del repo revisado

Poné `.diff-review.yml` (o `.json`) y `REVIEW.md` en el repo que revisás:

```yaml
# .diff-review.yml
ignore:
  - "**/Generated/**"
rulesFile: REVIEW.md   # default
```

`REVIEW.md` son reglas del equipo que van en el prompt. También se cargan
`CLAUDE.md` y `AGENTS.md` de la raíz y de cada carpeta de los archivos tocados.
Por default se ignoran lockfiles, `*.g.cs`, snapshots EF, `node_modules`, builds
y minificados.

## Estructura

```
.
├── bin/          # CLI (diff-review)
├── schema.json   # contrato del JSON que escribe el agente
├── lib/          # git / extract / prompt (dev + tests; va en el paquete)
└── web/          # UI SvelteKit → web/build en el paquete npm
```

Tests del pipeline: `npm test` (`node --test lib/*.test.mjs`).

## Publicar

```bash
npm run build    # o se corre solo en prepack (incluye web:install)
npm publish
```

Paquete: `@jpkme/diff-review` (el comando global sigue siendo `diff-review`).
El tarball incluye `web/build` (sin depender de las deps de Svelte en runtime).
