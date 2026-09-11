# diff-review

Revisa un branch contra su base y entrega cuatro cosas en un solo documento: la
**intención** del branch, los **temas** del diff, un **diccionario de bloques de
cambio** con qué y por qué, y los **hallazgos** de la review separados en riesgo
de merge y calidad de código.

Hay dos formas de usarlo.

## UI local (recomendado)

App SvelteKit en `web/` (adapter Node). El flujo es: generás un prompt con el
contexto (ruta del repo / branch / base / PR), lo corrís vos con tu agente
(Claude, Cursor, Copilot o el que uses, vía tu propia suscripción/sesión), y
soltás el JSON que te devuelve. La UI completa los diffs con `git` — el modelo
no los incluye en la salida, para no gastar tokens en el parche.

```bash
# una vez
cd web && bun install

# levantar la UI
bun run dev     # http://127.0.0.1:5190
```

Desde la raíz del repo también podés usar `bun run web:dev` (después de
`bun run web:install`).

En la home: pegá la ruta absoluta del repo y dale a "Cargar" para listar
branches. Copiá el prompt completo o el comando de skill (`/diff-review`, si lo
instalaste con los botones de descarga), y arrastrá el `.json` que te devuelva
a la dropzone. El botón "Ver ejemplo" carga un reporte de muestra sin necesidad
de correr nada.

En cada tramo que el parche no muestra aparece una barra con `↑` / `↓` / `todas`:
la UI pide el archivo completo en la punta del branch (`git show <branch>:<path>`) y
rellena las líneas ocultas como contexto. Si el repo no está a mano (por ejemplo, un
JSON soltado en otra máquina), los botones quedan deshabilitados con el aviso.

Los reportes se guardan en el **localStorage del navegador** (no en
`data/`), así que no se comparten entre dispositivos ni sobreviven a un
"borrar datos de navegación". Para compartir un reporte, usá "Descargar
JSON" y el archivo se puede volver a soltar en cualquier instancia de la
app.

## Uso por scripts (sin UI)

```bash
# review completa: git diff + modelo + documento en data/
node run-review.mjs --branch feat/mi-feature --base develop --agent claude

# solo el diff, sin llamar al modelo (para ver qué se le va a mandar)
node extract-diff.mjs --branch feat/mi-feature --base develop
```

`run-review.mjs` sale con código 2 si hay hallazgos bloqueantes, así que sirve
en CI.

## Cómo se le pregunta al modelo

**Un solo pedido.** El modelo ve el branch entero de una vez, que es lo que hace
falta para agrupar en temas coherentes y para encontrar hallazgos que
cruzan varios archivos.

El pedido lleva metadata en **JSON** (paths, archivos) y los **diffs crudos aparte**.

La respuesta es un **objeto JSON** validado contra `schema.json` más integridad
referencial. Si algo no cierra hay un turno de corrección barato (sin reenviar diffs).

Si el diff no entra en un turno, se compacta (sin líneas de contexto) y si sigue
grande se parte en **lotes en paralelo** (2 workers, pool global de 2 CLIs). Tras
los lotes hay un **turno de síntesis** que unifica temas e `intent`. Queda anotado
en `notes` cuando hubo lotes.

## Qué se reporta y qué no

Los hallazgos tienen dos ejes. `class=risk` es lo que puede romper en producción
o al mergear, y solo eso puede marcar `blocking`. `class=quality` son mejoras
reales de mantenibilidad —duplicación, acoplamiento, complejidad, abstracciones
filtradas, nombres que mienten— y nunca frenan un merge.

No se reporta lo que ya cazan el linter, el typechecker, el formatter o el CI,
ni preferencias de estilo sin consecuencia, ni "falta documentación" sin un
escenario concreto que se rompa.

## Configuración del repo revisado

Poné `.diff-review.yml` (o `.json`) y `REVIEW.md` en el repo que revisás:

```yaml
# .diff-review.yml
ignore:
  - "**/Generated/**"
model: sonnet          # opcional; usado por run-review.mjs, no por la UI web
rulesFile: REVIEW.md   # default
```

`REVIEW.md` son reglas del equipo que van en el prompt. También se cargan
`CLAUDE.md` y `AGENTS.md` de la raíz y de cada carpeta de los archivos tocados.
Por default se ignoran lockfiles, `*.g.cs`, snapshots EF, `node_modules`, builds
y minificados.

## Estructura

```
.
├── schema.json          # contrato del documento de review (v2)
├── extract-diff.mjs     # CLI: solo diff
├── run-review.mjs       # CLI: review completa
├── lib/                 # pipeline (git, prompt, validate, agents…)
├── web/                 # UI SvelteKit
├── data/                # reportes de la CLI (gitignored)
└── output/              # artefactos auxiliares (gitignored)
```

Los tests del pipeline: `node --test lib/*.test.mjs` (o `bun run test` / `npm test`).
