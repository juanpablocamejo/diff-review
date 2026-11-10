<script lang="ts">
	import { plural } from './labels';
	import type { PublishPlatform } from './prompts';
	import ResizeHandle from './ResizeHandle.svelte';

	const DRAWER_WIDTH_DEFAULT = 440;
	const DRAWER_WIDTH_MIN = 320;
	const DRAWER_WIDTH_MAX = 720;

	let {
		mode,
		findingCount,
		fixPromptText = '',
		publishText = '',
		fixCopyLabel = 'Copiar',
		publishCopyLabel = 'Copiar',
		publishPlatform = 'github',
		publishTargetLabel = 'pull request de GitHub',
		onsetpublishplatform,
		oncopyfix,
		oncopypublish,
		onclose,
		onfixwithagent
	}: {
		mode: 'fix' | 'publish';
		findingCount: number;
		fixPromptText?: string;
		publishText?: string;
		fixCopyLabel?: string;
		publishCopyLabel?: string;
		publishPlatform?: PublishPlatform;
		publishTargetLabel?: string;
		onsetpublishplatform?: (platform: PublishPlatform) => void;
		oncopyfix?: () => void;
		oncopypublish?: () => void;
		onclose: () => void;
		onfixwithagent?: () => void;
	} = $props();

	let drawerWidth = $state(DRAWER_WIDTH_DEFAULT);

	const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

	const title = $derived(
		mode === 'fix'
			? `Prompt de corrección · ${plural(findingCount, 'hallazgo', 'hallazgos')}`
			: `Publicar · ${plural(findingCount, 'hallazgo', 'hallazgos')}`
	);

	const textareaValue = $derived(mode === 'fix' ? fixPromptText : publishText);

	const copyLabel = $derived(
		mode === 'fix'
			? fixCopyLabel === 'Copiar'
				? 'Copiar prompt'
				: fixCopyLabel
			: publishCopyLabel
	);
</script>

<div
	class={['prompt-shell', { fix: mode === 'fix', publish: mode === 'publish' }]}
	style:width="{drawerWidth}px"
	aria-label={title}
>
	<!-- Arrastrar a la izquierda ensancha (borde izquierdo del panel). -->
	<ResizeHandle ondrag={(dx) => (drawerWidth = clamp(drawerWidth - dx, DRAWER_WIDTH_MIN, DRAWER_WIDTH_MAX))} />
	<aside class="prompt-drawer">
		<header>
			<h2 class="title">{title}</h2>
			<button type="button" class="close" title="Cerrar" aria-label="Cerrar panel" onclick={onclose}
				>✕</button
			>
		</header>

		<div class="body">
			{#if mode === 'fix'}
				<p class="hint">
					Copiá el prompt de corrección o enviálo al chat con «Corregir con agente» (podés cambiar de agente
					ahí antes de enviar). Cada hallazgo se ubica por archivo:línea.
				</p>
			{:else}
				<div class="mode-toggle">
					<button
						type="button"
						class={{ on: publishPlatform === 'github' }}
						onclick={() => onsetpublishplatform?.('github')}>GitHub</button
					>
					<button
						type="button"
						class={{ on: publishPlatform === 'gitlab' }}
						onclick={() => onsetpublishplatform?.('gitlab')}>GitLab</button
					>
				</div>
			{/if}

			<textarea readonly value={textareaValue}></textarea>

			{#if mode === 'publish'}
				<p class="hint">
					Copiá y pegá como comentario en el {publishTargetLabel}. Markdown listo, un bloque por hallazgo
					marcado.
				</p>
			{/if}

			<div class="actions">
				{#if mode === 'fix'}
					<button type="button" class="copy" onclick={() => oncopyfix?.()}>{copyLabel}</button>
					{#if onfixwithagent}
						<button type="button" class="outline" onclick={onfixwithagent}>Corregir con agente</button>
					{/if}
				{:else}
					<button type="button" class="copy" onclick={() => oncopypublish?.()}>{copyLabel}</button>
				{/if}
			</div>
		</div>
	</aside>
</div>

<style>
	.prompt-shell {
		flex-shrink: 0;
		display: flex;
		min-width: 0;
		min-height: 0;
		align-self: stretch;
	}

	.prompt-drawer {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-left: 1px solid var(--border);
		background: var(--bg-elev);
	}

	.prompt-shell.fix .prompt-drawer {
		border-left-color: var(--fix-border);
		background: var(--fix-bg);
	}

	.prompt-shell.publish .prompt-drawer {
		border-left-color: var(--publish-border);
		background: var(--publish-bg);
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}

	.title {
		margin: 0;
		font-size: 12px;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		font-weight: 650;
		min-width: 0;
	}

	.prompt-shell.fix .title {
		color: var(--fix-text);
	}

	.prompt-shell.publish .title {
		color: var(--publish-text);
	}

	.close {
		background: transparent;
		border: 0;
		color: var(--text-dim);
		font-size: 13px;
		cursor: pointer;
		flex-shrink: 0;
		padding: 0;
	}

	.body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 14px;
	}

	.hint {
		margin: 0;
		font-size: 11.5px;
		color: var(--text-faint);
		line-height: 1.45;
	}

	.mode-toggle {
		display: flex;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
		width: fit-content;
		flex-shrink: 0;
	}

	.mode-toggle button {
		padding: 6px 12px;
		font-size: 12px;
		border: 0;
		background: transparent;
		color: var(--text);
		cursor: pointer;
	}

	.mode-toggle button + button {
		border-left: 1px solid var(--border);
	}

	.mode-toggle button.on {
		background: var(--accent-soft);
	}

	textarea {
		flex: 1;
		min-height: 180px;
		width: 100%;
		resize: none;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 12px;
		font-family: var(--mono);
		font-size: 12px;
		line-height: 1.5;
		color: var(--text);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		flex-shrink: 0;
	}

	.copy,
	.outline {
		padding: 9px 14px;
		font-weight: 600;
		font-size: 13px;
		cursor: pointer;
	}

	.copy {
		background: var(--btn-primary-bg);
		border: 1px solid var(--btn-primary-border);
		border-radius: var(--radius);
		color: var(--btn-primary-text);
	}

	.outline {
		background: transparent;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--text);
	}

	.outline:hover {
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	@media (max-width: 768px) {
		.prompt-shell {
			position: fixed;
			inset: 0;
			z-index: 55;
			width: 100% !important;
			max-width: none;
			background: var(--bg);
		}

		.prompt-shell :global(.resize-handle),
		.prompt-shell :global([aria-orientation='vertical']) {
			display: none;
		}

		.prompt-drawer {
			border-left: 0;
			width: 100%;
		}
	}
</style>
