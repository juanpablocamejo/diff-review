# diff-review

App local para revisar un branch: generás un prompt, lo corrés vos con tu agente
(Claude, Cursor, Copilot, etc.), soltás el JSON que te devuelve, y la UI completa
los diffs con `git` y te deja triager hallazgos.

No spawnea agentes ni corre reviews sola: el modelo lo manejás vos a mano.

## Cómo usarla

```bash
cd web && bun install
bun run dev     # http://127.0.0.1:5190
```

Desde la raíz: `bun run web:install` y `bun run web:dev`.

1. Pegá la ruta (o URL) del repo y elegí branch / base.
2. Copiá el prompt (o el comando de skill `/diff-review`).
3. Corrélo en tu agente; que escriba `diff-review-output.json`.
4. Arrastrá ese JSON a la dropzone. La UI hidrata los diffs con git.

"Ver ejemplo" carga un reporte de muestra sin tocar un repo.

## Qué hace git (en tu máquina)

Al abrir un reporte, el backend local corre `git` contra el repo que indicaste
para armar los diffs y, si pedís contexto faltante, leer el archivo en la punta
del branch. Por eso corre en localhost con adapter Node, no como SaaS.

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
├── schema.json   # contrato del JSON que escribe el agente
├── lib/          # git, extract de diff, normalización del documento
└── web/          # UI SvelteKit (prompts, viewer, triage)
```

Tests del pipeline: `node --test lib/*.test.mjs` (o `bun run test`).
