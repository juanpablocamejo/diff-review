import { resolve } from '$app/paths';
import { applyEvent, type SeqEvent, type SessionStatus } from './agent-events';

/**
 * Sigue por SSE los eventos de una sesión con el agente. Al (re)conectar el server manda `reset` y repite todo;
 * `onEvent` ve cada `seq` una sola vez aunque se repita la historia.
 */
export class AgentStream {
	events = $state<SeqEvent[]>([]);
	status = $state<SessionStatus>('idle');
	/** La sesión ya no existe en el server (se reinició). */
	gone = $state(false);

	#source: EventSource | null = null;
	#seen = new Set<number>();
	#onEvent?: (event: SeqEvent) => void;

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
		this.close();
		const source = new EventSource(resolve(`/api/agent/${encodeURIComponent(this.id)}/events`));
		source.onmessage = (message) => {
			const data = JSON.parse(message.data) as SeqEvent | { type: 'reset' };
			if (data.type === 'reset') {
				this.events = [];
				return;
			}
			this.events = applyEvent(this.events, data);
			if (data.type === 'status') this.status = data.status;
			if (!this.#seen.has(data.seq)) {
				this.#seen.add(data.seq);
				this.#onEvent?.(data);
			}
		};
		source.onerror = () => {
			// EventSource reintenta solo; si el server ya no conoce la sesión, responde 404 y queda cerrado.
			if (source.readyState === EventSource.CLOSED) this.gone = true;
		};
		this.#source = source;
	}

	close() {
		this.#source?.close();
		this.#source = null;
	}
}
