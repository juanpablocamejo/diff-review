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

Abre `http://127.0.0.1:5190`. Opciones: `--port`, `--host`, `--no-open`.

Si lo lanzás desde un repositorio git, la UI precarga esa ruta y el branch actual.

## Desarrollo (desde el repo)

```bash
npm run web:install
npm run web:dev          # UI en modo dev
npm run build            # build de producción → web/build
npm start                # mismo que el bin global
```

## Flujo

1. Pegá la ruta (o URL) del repo y elegí branch / base — o lanzá `diff-review` desde el repo y se precarga solo.
2. Copiá el prompt (o el comando de skill `/diff-review`).
3. Corrélo en tu agente; que escriba `diff-review-output.json`.
4. Arrastrá ese JSON a la dropzone. La UI hidrata los diffs con git.

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
├── lib/          # git / extract (dev + tests; va embebido en el build)
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
