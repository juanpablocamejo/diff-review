<script lang="ts">
	import { renderAgentMarkdown } from './markdown';

	let { text = '' }: { text?: string } = $props();

	const html = $derived(renderAgentMarkdown(text));
</script>

<div class="md">{@html html}</div>

<style>
	.md {
		color: var(--text);
		overflow-wrap: anywhere;
	}

	.md :global(> :first-child) {
		margin-top: 0;
	}

	.md :global(> :last-child) {
		margin-bottom: 0;
	}

	.md :global(p),
	.md :global(ul),
	.md :global(ol),
	.md :global(pre),
	.md :global(blockquote) {
		margin: 0.45em 0;
	}

	.md :global(ul),
	.md :global(ol) {
		padding-left: 1.35em;
	}

	.md :global(li) {
		margin: 0.15em 0;
	}

	.md :global(h1),
	.md :global(h2),
	.md :global(h3),
	.md :global(h4) {
		margin: 0.7em 0 0.35em;
		font-size: 1em;
		font-weight: 650;
		line-height: 1.35;
	}

	.md :global(h1) {
		font-size: 1.15em;
	}

	.md :global(h2) {
		font-size: 1.08em;
	}

	.md :global(a) {
		color: var(--accent);
	}

	.md :global(code) {
		font-family: var(--mono);
		font-size: 0.92em;
		padding: 0.1em 0.35em;
		border-radius: 4px;
		background: var(--bg-card);
		border: 1px solid var(--border-soft, var(--border));
	}

	.md :global(pre) {
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		overflow-x: auto;
	}

	.md :global(pre code) {
		padding: 0;
		border: none;
		background: transparent;
		font-size: 12px;
		line-height: 1.45;
	}

	.md :global(blockquote) {
		padding-left: 10px;
		border-left: 3px solid var(--border);
		color: var(--text-dim);
	}

	.md :global(hr) {
		border: none;
		border-top: 1px solid var(--border);
		margin: 0.75em 0;
	}

	.md :global(table) {
		border-collapse: collapse;
		width: 100%;
		font-size: 12.5px;
	}

	.md :global(th),
	.md :global(td) {
		border: 1px solid var(--border);
		padding: 4px 8px;
		text-align: left;
	}

	.md :global(th) {
		background: var(--bg-card);
		font-weight: 600;
	}
</style>
