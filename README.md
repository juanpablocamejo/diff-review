# diff-review

App local para revisar un branch: generás un prompt, lo corrés vos con tu agente
(Claude, Cursor, Copilot, etc.), soltás el JSON que te devuelve, y la UI completa
los diffs con `git` y te deja triager hallazgos.

No spawnea agentes ni corre reviews sola: el modelo lo manejás vos a mano.

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
2. Copia el prompt al portapapeles y espera el JSON (`diff-rev_{branchTip}_{baseTip}.json`).
3. Valida y abre el viewer con el reporte ya importado.

Si pasás `--branch` y `--base` juntos, saltea los selects. Si quedan iguales (diff vacío), abre la UI.

Si ya hay un JSON válido para esos mismos commits, pregunta si abrir el existente o generarlo de nuevo; en ese
caso el archivo viejo no cuenta hasta que el agente lo reescriba. Sin terminal interactiva no pregunta: con
`--agent` lo genera de nuevo y sin `--agent` abre el existente.

### Lanzar el agente (`--agent`)

Si hay agentes instalados, después de branch y base un solo select lista copiar el prompt al portapapeles (primera
opción) y cada agente detectado. Con `--agent` saltea esa lista y va directo a elegir agente y modelo:

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

Para abrir la UI primero (sin esperar el JSON):

```bash
diff-review --ui
```

Opciones: `--port` (si está ocupado, usa el siguiente libre), `--host`, `--base`, `--branch`, `--agent`, `--no-open`.

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
2. Copiá el prompt (o el comando de skill `/diff-review`).
3. Corrélo en tu agente; que escriba `diff-rev_{branchTip}_{baseTip}.json` y lo valide con `npx --yes @jpkme/diff-review validate <archivo>` (también acepta nombres legacy).
4. Arrastrá ese JSON a la dropzone (o dejá que el CLI lo importe solo). La UI hidrata los diffs con git.

"Ver ejemplo" carga un reporte de muestra sin tocar un repo.

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
