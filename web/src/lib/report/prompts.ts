import { hunkCovers, parseUnifiedDiff } from './diff';
import { severityLabel } from './labels';
import type { FindingSeverity, ReportMeta, ReviewDocument } from './types';

export const OUTPUT_SCHEMA_BLOCK = `{
  "intent": "2-4 oraciones: qué problema resuelve el branch y cómo. Sin listar archivos.",
  "groups": [
    { "id": "g1", "kind": "feat|fix|refactor|perf|test|chore|docs|infra", "title": "imperativo, tipo(scope): título, máx 72 caracteres", "intent": "1-2 oraciones sobre este tema" }
  ],
  "blocks": [
    {
      "id": "b1", "group": "g1", "file": "path/relativo/al/archivo.ext", "lines": "L40-58",
      "side": "new|old", "start": 40, "end": 58, "op": "add|mod|del|rename",
      "what": "qué cambia, máx 120 caracteres", "why": "por qué, máx 120 caracteres",
      "source": "code|commit|pr|issue|inferred"
    }
  ],
  "findings": [
    {
      "id": "f1", "class": "risk|quality", "severity": "high|med|low|nit",
      "blocking": false,
      "kind": "bug|race|auth|security|api-break|missing-test|perf|maintainability|docs|other",
      "file": "path/relativo/al/archivo.ext", "line": 87, "block": "b1",
      "what": "qué está mal, máx 120 caracteres", "fix": "cómo arreglarlo, máx 120 caracteres"
    }
  ],
  "skipped": [
    { "file": "path/relativo", "reason": "generated|lockfile|format|vendored|binary|trivial|ignored" }
  ],
  "notes": ["notas breves sobre limitaciones de la review, si aplica"]
}`;

const RULES = `- NO reportar: código preexistente fuera del diff, ruido de linter/formatter, preferencias de naming/estilo sin consecuencia real, comportamiento intencional del branch, reglas de lint silenciadas, "falta doc/cobertura" sin un escenario concreto roto.
- Los hallazgos de calidad tienen que nombrar un costo concreto, no una sensación vaga.
- "blocking": true SOLO si el branch no debería mergearse tal como está.
- Un "block" por tramo de cambio con sentido propio (no uno por línea). Cada finding puntual usa el "block" de ese tramo; si es transversal, "block" queda vacío.`;

/** Nombre del archivo donde el agente debe escribir el JSON (intent/groups/blocks/findings; el diff lo arma la UI con git). */
export const OUTPUT_FILENAME = 'diff-review-output.json';

export function buildPrompt(meta: ReportMeta): string {
	const repo =
		meta.repo.trim() || (meta.source === 'url' ? '<url del repo>' : '<ruta absoluta del repo>');
	const branch = meta.branch.trim() || '<branch a revisar>';
	const base = meta.base.trim() || 'develop';
	const access =
		meta.source === 'url'
			? `El repo está en remoto. Si no lo tenés local, clonalo (o usá el acceso que tengas) y corré \`git diff ${base}...${branch}\` (o el diff que corresponda); leé los archivos que necesites para entender tipos, callers y tests. No modifiques nada.`
			: `Tenés acceso al repo: corré \`git diff ${base}...${branch}\` (o el diff que corresponda) y leé los archivos que necesites para entender tipos, callers y tests. No modifiques nada.`;
	return `Actuá como revisor de código senior, exigente pero justo.

Repo: ${repo}
Branch a revisar: ${branch}
Base (merge-base): ${base}

${access}

Reglas:
${RULES}

Escribí el resultado en un archivo llamado \`${OUTPUT_FILENAME}\` en la raíz del repo. El archivo debe tener UN SOLO objeto JSON, sin texto antes ni después, sin bloques \`\`\`, con esta forma exacta:

${OUTPUT_SCHEMA_BLOCK}

NO incluyas diffs ni un array "files": la herramienta los calcula con git al abrir el reporte. Tampoco inventes hunks ni copies el parche al JSON.

Cuando termines, avisame que \`${OUTPUT_FILENAME}\` quedó escrito.`;
}

/** Cuántos archivos sin cubrir se listan en el prompt antes de cortar. */
const COVERAGE_LIST_LIMIT = 120;

/**
 * Prompt para la pasada que falta: el contrato exige que todo archivo del diff caiga en
 * `blocks` o en `skipped`, y estos quedaron afuera. Pide el JSON completo de nuevo (no un
 * parche) porque la UI ingiere un documento entero, no fusiona partes.
 */
export function buildCoveragePromptText(meta: ReportMeta, missing: string[]): string {
	const branch = meta.branch.trim() || '<branch>';
	const base = (meta.base || 'develop').trim();
	const shown = missing.slice(0, COVERAGE_LIST_LIMIT);
	const rest = missing.length - shown.length;
	const list = shown.map((path) => `- ${path}`).join('\n');
	const tail = rest > 0 ? `\n- … y ${rest} más (están todos en el diff)` : '';
	return [
		`La review de \`${branch}\` contra \`${base}\` quedó incompleta: ${missing.length} archivo(s) del diff no aparecen ni en "blocks" ni en "skipped".`,
		'',
		'Completá la cobertura de estos archivos:',
		list + tail,
		'',
		'Para cada uno: si el cambio dice algo, agregá un "block" con su tema, su rango de líneas y what/why; si es ruido (generado, lockfile, formato, vendored, binario, trivial), sumalo a "skipped" con su razón. Podés usar un glob en "skipped" cuando sean varios del mismo tipo.',
		'',
		'No rehagas lo ya hecho: mantené los "blocks", "findings", "groups" e "intent" que ya habías escrito y agregá lo que falta.',
		'',
		`Reescribí \`${OUTPUT_FILENAME}\` con el JSON completo (un solo objeto, mismo formato, sin texto alrededor).`
	].join('\n');
}

export function buildCommandText(meta: ReportMeta): string {
	const parts: string[] = [];
	if (meta.repo.trim()) parts.push(`repo=${meta.repo.trim()}`);
	if (meta.branch.trim()) parts.push(`branch=${meta.branch.trim()}`);
	parts.push(`base=${(meta.base || 'develop').trim()}`);
	return `/diff-review ${parts.join(' ')}`.trim();
}

export type SkillAgent = 'claude' | 'cursor' | 'copilot';

const SKILL_AGENTS: Record<SkillAgent, { filename: string; argToken: string }> = {
	claude: { filename: 'diff-review.md', argToken: '$ARGUMENTS' },
	cursor: { filename: 'diff-review.md', argToken: '$ARGUMENTS' },
	copilot: { filename: 'diff-review.prompt.md', argToken: '${input:args}' }
};

export function skillFilename(agent: SkillAgent): string {
	return SKILL_AGENTS[agent].filename;
}

export function buildSkillMarkdown(agent: SkillAgent): string {
	const cfg = SKILL_AGENTS[agent];
	const ext = cfg.filename.split('.').pop();
	return `---
description: Genera un reporte de code review en el JSON que espera diff-review
---

# /diff-review

Uso: /diff-review repo=<repo> branch=<branch> base=<base>
Argumentos: ${cfg.argToken}

Actuá como revisor de código senior, exigente pero justo. Corré \`git diff <base>...<branch>\` (o el diff que corresponda) y leé los archivos que necesites para entender tipos, callers y tests. No modifiques nada.

Reglas:
${RULES}

Escribí el resultado en un archivo llamado \`${OUTPUT_FILENAME}\` en la raíz del repo. El archivo debe tener UN SOLO objeto JSON, sin texto antes ni después, sin bloques \`\`\`, con esta forma exacta:

${OUTPUT_SCHEMA_BLOCK}

NO incluyas diffs ni un array "files": la herramienta los calcula con git al abrir el reporte.

Cuando termines, avisá que \`${OUTPUT_FILENAME}\` quedó escrito.

> Este archivo define dos comandos. Si tu herramienta requiere un archivo por comando, separá esta sección en un segundo archivo "diff-review-fix.${ext}".

# /diff-review-fix

Uso: /diff-review-fix <id1,id2,...> repo=<repo> branch=<branch>
Argumentos: ${cfg.argToken}

Se te va a pasar una lista de hallazgos (archivo:línea, qué está mal, fix sugerido y a veces el diff del bloque). Aplicá SOLO esas correcciones, no toques nada más. Si falta contexto, releé el archivo antes de tocarlo.

Al terminar, resumí en una lista qué cambiaste por cada hallazgo.`;
}

export function buildFixCommandText(meta: ReportMeta, ids: string[]): string {
	const parts = [`/diff-review-fix ${ids.join(',')}`];
	if (meta.repo.trim()) parts.push(`repo=${meta.repo.trim()}`);
	if (meta.branch.trim()) parts.push(`branch=${meta.branch.trim()}`);
	return parts.join(' ');
}

/** Findings con su número de orden (1-based, según el orden original del documento) para citarlos en los prompts. */
export type NumberedFinding = {
	number: number;
	file: string;
	line: number | null;
	block: string;
	blocking: boolean;
	severity: FindingSeverity;
	what: string;
	fix: string;
};

export function buildFixPromptText(
	selectedFindings: NumberedFinding[],
	doc: ReviewDocument,
	meta: ReportMeta
): string {
	const blocksById = new Map(doc.blocks.map((b) => [b.id, b]));
	const filesByPath = new Map(doc.files.map((f) => [f.path, f]));

	const chunks = selectedFindings.map((f, i) => {
		let diffSnippet = '';
		const block = f.block ? blocksById.get(f.block) : null;
		if (block) {
			const file = filesByPath.get(block.file);
			if (file?.diff) {
				const hunks = parseUnifiedDiff(file.diff);
				const hunk = hunks.find((h) => hunkCovers(h, { side: block.side, start: block.start, end: block.end }));
				if (hunk) {
					const body = hunk.lines
						.map((l) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text)
						.join('\n');
					diffSnippet = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${hunk.header ? ' ' + hunk.header : ''}\n${body}`;
				}
			}
		}
		const label = f.blocking ? 'BLOQUEA' : severityLabel(f.severity).toUpperCase();
		let out = `${i + 1}. [${label}] ${f.file}${f.line ? ':' + f.line : ''}\nQué: ${f.what}\nFix sugerido: ${f.fix}`;
		if (diffSnippet) out += `\n\n\`\`\`diff\n${diffSnippet}\n\`\`\``;
		return out;
	});

	return `Actuá como el mismo revisor que generó estos hallazgos. Aplicá SOLO las correcciones listadas abajo, sin tocar nada más. Si un fix requiere más contexto, releé el archivo antes de tocarlo.

Repo: ${meta.repo || '—'}
Branch: ${meta.branch || '—'}
Base: ${meta.base || 'develop'}

Hallazgos a corregir (${selectedFindings.length}):

${chunks.join('\n\n')}

Cuando termines, resumí en una lista qué cambiaste por cada hallazgo.`;
}

export type PublishPlatform = 'github' | 'gitlab';

export function buildPublishText(
	selectedFindings: NumberedFinding[],
	platform: PublishPlatform,
	meta: ReportMeta
): string {
	const label = platform === 'gitlab' ? 'MR' : 'PR';
	const chunks = selectedFindings.map((f) => {
		const loc = f.file + (f.line ? ':' + f.line : '');
		const badge = f.blocking ? 'BLOQUEA' : severityLabel(f.severity).toUpperCase();
		return `**#${f.number} · ${badge}** \`${loc}\`\n\n${f.what}\n\n**Sugerencia:** ${f.fix}`;
	});
	return `### Hallazgos de code review${meta.branch ? ' — ' + meta.branch : ''}\n\n${chunks.join('\n\n---\n\n')}\n\n_Generado a partir del review automático. Comentario para ${label}._`;
}
