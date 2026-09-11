<script lang="ts">
	/** Barra angosta arrastrable: reporta el delta en px al padre, que decide qué medida ajustar. */
	let { ondrag }: { ondrag: (dx: number) => void } = $props();

	let dragging = $state(false);

	function onPointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		const handle = e.currentTarget as HTMLElement;
		handle.setPointerCapture(e.pointerId);
		dragging = true;
		const prevCursor = document.body.style.cursor;
		const prevUserSelect = document.body.style.userSelect;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';

		let lastX = e.clientX;
		// Varios pointermove pueden llegar entre frames: se acumulan y se aplican una sola
		// vez por rAF, si no cada evento dispara un re-render + reflow y se traba.
		let pendingDx = 0;
		let rafId: number | null = null;

		function flush() {
			rafId = null;
			if (pendingDx) {
				ondrag(pendingDx);
				pendingDx = 0;
			}
		}
		function onMove(ev: PointerEvent) {
			const dx = ev.clientX - lastX;
			lastX = ev.clientX;
			pendingDx += dx;
			if (rafId == null) rafId = requestAnimationFrame(flush);
		}
		function onUp(ev: PointerEvent) {
			if (rafId != null) {
				cancelAnimationFrame(rafId);
				flush();
			}
			dragging = false;
			document.body.style.cursor = prevCursor;
			document.body.style.userSelect = prevUserSelect;
			handle.releasePointerCapture(ev.pointerId);
			handle.removeEventListener('pointermove', onMove);
			handle.removeEventListener('pointerup', onUp);
		}
		handle.addEventListener('pointermove', onMove);
		handle.addEventListener('pointerup', onUp);
	}
</script>

<div
	class="resize-handle"
	class:dragging
	role="separator"
	aria-orientation="vertical"
	tabindex="-1"
	onpointerdown={onPointerDown}
></div>

<style>
	.resize-handle {
		width: 6px;
		flex-shrink: 0;
		cursor: col-resize;
		position: relative;
		z-index: 2;
		background: transparent;
		touch-action: none;
	}

	.resize-handle::after {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		left: 2px;
		width: 2px;
		background: transparent;
	}

	.resize-handle:hover::after,
	.resize-handle.dragging::after {
		background: var(--accent);
	}
</style>
