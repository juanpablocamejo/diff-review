import { resolve } from '$app/paths';
import { applyEvent, type SeqEvent, type SessionStatus } from './agent-events';

/**
 * Sigue por SSE los eventos de una sesión con el agente. Al (re)conectar el server manda `reset` y repite todo;
 * `onEvent` ve cada `seq` una sola vez aunque se repita la historia.
 */
export class AgentStream {
	events = $state<SeqEvent[]>([]);
	status = $state<SessionStatus>('idle');
	/** Último mensaje de un status error (mismo texto que ve la CLI). */
	errorMessage = $state('');
	/** La sesión ya no existe en el server (se reinició). */
	gone = $state(false);

	#source: EventSource | null = null;
	#seen = new Set<number>();
	#onEvent?: (event: SeqEvent) => void;
	#retries = 0;
	#retryTimer: ReturnType<typeof setTimeout> | null = null;
	#closed = false;

	constructor(
		readonly id: string,
		onEvent?: (event: SeqEvent) => void
	) {
		this.#onEvent = onEvent;
	}

	get busy() {
		return this.status === 'starting' || this.status === 'working';
	}

	connect() {
		this.#closed = false;
		this.#open();
	}

	#open() {
		if (this.#closed) return;
		this.#source?.close();
		this.#source = null;
		if (this.#retryTimer) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = null;
		}

		const source = new EventSource(resolve(`/api/agent/${encodeURIComponent(this.id)}/events`));
		source.onmessage = (message) => {
			this.#retries = 0;
			this.gone = false;
			const data = JSON.parse(message.data) as SeqEvent | { type: 'reset' };
			if (data.type === 'reset') {
				this.events = [];
				this.errorMessage = '';
				return;
			}
			this.events = applyEvent(this.events, data);
			if (data.type === 'status') {
				this.status = data.status;
				if (data.status === 'error') {
					this.errorMessage = data.message || this.errorMessage || 'Error del agente.';
				}
			}
			if (!this.#seen.has(data.seq)) {
				this.#seen.add(data.seq);
				this.#onEvent?.(data);
			}
		};
		source.onerror = () => {
			// 404 (sesión todavía no creada) u otro corte: reintentar un rato antes de marcar gone.
			if (source.readyState !== EventSource.CLOSED) return;
			source.close();
			if (this.#closed) return;
			if (this.#retries < 25) {
				this.#retries += 1;
				this.#retryTimer = setTimeout(() => this.#open(), 200);
				return;
			}
			this.gone = true;
		};
		this.#source = source;
	}

	close() {
		this.#closed = true;
		if (this.#retryTimer) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = null;
		}
		this.#source?.close();
		this.#source = null;
	}
}
