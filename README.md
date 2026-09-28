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

Para abrir la UI primero (sin esperar el JSON):

```bash
diff-review --ui
```

Opciones: `--port`, `--host`, `--base`, `--branch`, `--no-open`.

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
