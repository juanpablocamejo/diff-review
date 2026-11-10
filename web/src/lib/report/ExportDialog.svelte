<script lang="ts">
	import {
		DEFAULT_EXPORT_SECTIONS,
		EXPORT_SECTION_OPTIONS,
		downloadReport,
		type ExportFormat,
		type ExportSection
	} from './export';
	import type { SavedReport } from './types';

	let {
		report,
		open = false,
		onclose
	}: {
		report: SavedReport;
		open?: boolean;
		onclose: () => void;
	} = $props();

	let sections = $state<Record<ExportSection, boolean>>(
		Object.fromEntries(DEFAULT_EXPORT_SECTIONS.map((id) => [id, true])) as Record<
			ExportSection,
			boolean
		>
	);
	let format = $state<ExportFormat>('md');

	const selected = $derived(
		EXPORT_SECTION_OPTIONS.map((o) => o.id).filter((id) => sections[id])
	);
	const canExport = $derived(format === 'json' || selected.length > 0);

	function presetShare() {
		sections = {
			summary: true,
			intent: false,
			notes: false,
			themes: false,
			findings: true,
			fixes: true,
			skipped: false,
			snippets: false
		};
		format = 'md';
	}

	function presetAll() {
		sections = Object.fromEntries(DEFAULT_EXPORT_SECTIONS.map((id) => [id, true])) as Record<
			ExportSection,
			boolean
		>;
	}

	let busy = $state(false);

	async function exportNow() {
		if (!canExport || busy) return;
		busy = true;
		try {
			await downloadReport(report, format, format === 'json' ? {} : { sections: selected });
		} finally {
			busy = false;
		}
		onclose();
	}

	function onKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<div class="backdrop" role="presentation" onclick={onclose}></div>
	<div
		class="dialog"
		role="dialog"
		tabindex="-1"
		aria-modal="true"
		aria-labelledby="export-title"
		onclick={(e) => e.stopPropagation()}
		onkeydown={(e) => e.stopPropagation()}
	>
		<h2 id="export-title">Exportar reporte</h2>
		<p class="lead">Elegí el formato y qué secciones incluir (útil para compartir solo hallazgos + fixes).</p>

		<div class="presets">
			<button type="button" class="ghost" onclick={presetShare}>Hallazgos + fixes</button>
			<button type="button" class="ghost" onclick={presetAll}>Todo</button>
		</div>

		<fieldset class="sections" disabled={format === 'json'}>
			<legend>Secciones</legend>
			{#each EXPORT_SECTION_OPTIONS as opt (opt.id)}
				<label class="check">
					<input type="checkbox" bind:checked={sections[opt.id]} />
					<span class="label">{opt.label}</span>
					<span class="hint">{opt.hint}</span>
				</label>
			{/each}
			{#if format === 'json'}
				<p class="note">JSON siempre exporta el documento completo (para reimportar).</p>
			{/if}
		</fieldset>

		<label class="field">
			<span>Formato</span>
			<select bind:value={format}>
				<option value="md">Markdown</option>
				<option value="html">HTML</option>
				<option value="pdf">PDF</option>
				<option value="json">JSON</option>
			</select>
		</label>

		<div class="actions">
			<button type="button" onclick={onclose}>Cancelar</button>
			<button type="button" class="primary" disabled={!canExport || busy} onclick={exportNow}>
				{busy ? 'Generando PDF…' : 'Exportar'}
			</button>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		background: color-mix(in srgb, #000 40%, transparent);
	}

	.dialog {
		position: fixed;
		z-index: 81;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: min(440px, calc(100vw - 32px));
		max-height: calc(100vh - 48px);
		overflow: auto;
		padding: 18px 20px;
		background: var(--bg-elev);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: 0 16px 40px color-mix(in srgb, #000 28%, transparent);
	}

	h2 {
		margin: 0 0 8px;
		font-size: 15px;
		font-weight: 650;
	}

	.lead {
		margin: 0 0 12px;
		font-size: 13px;
		line-height: 1.45;
		color: var(--text-dim);
	}

	.presets {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-bottom: 12px;
	}

	.sections {
		margin: 0 0 14px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.sections:disabled {
		opacity: 0.55;
	}

	legend {
		padding: 0 4px;
		font-size: 11px;
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-faint);
	}

	.check {
		display: grid;
		grid-template-columns: auto 1fr;
		grid-template-rows: auto auto;
		column-gap: 8px;
		align-items: baseline;
		font-size: 13px;
		cursor: pointer;
	}

	.check input {
		grid-row: 1 / span 2;
		margin: 2px 0 0;
	}

	.check .label {
		color: var(--text);
		font-weight: 550;
	}

	.check .hint,
	.note {
		grid-column: 2;
		font-size: 11.5px;
		color: var(--text-faint);
	}

	.note {
		margin: 4px 0 0;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12px;
		color: var(--text-dim);
		margin-bottom: 16px;
	}

	.field select {
		padding: 7px 10px;
		font: inherit;
		font-size: 13px;
		color: var(--text);
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	.actions button,
	.presets button {
		padding: 7px 12px;
		font-size: 13px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
		cursor: pointer;
	}

	.presets button.ghost {
		font-size: 12px;
		padding: 5px 10px;
		background: transparent;
	}

	.actions button.primary {
		background: var(--btn-primary-bg);
		border-color: var(--btn-primary-border);
		color: var(--btn-primary-text);
	}

	.actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
