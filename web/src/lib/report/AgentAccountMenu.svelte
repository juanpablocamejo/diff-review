<script lang="ts">
	import { agentAccount, openAgentLogin, openAgentLogout } from './agent.remote';

	let {
		agentId = '',
		agentLabel = '',
		sessionId = '',
		/** Ocultar acciones (p. ej. ya hay CTAs de login en la pantalla de error). */
		showActions = true,
		/** Sube tras login/logout hecho fuera de este menú, para releer la cuenta. */
		refreshToken = 0,
		/** true solo con sesión y etiqueta de cuenta (misma regla que "Cambiar cuenta"). */
		onaccount = undefined as undefined | ((loggedIn: boolean) => void),
		/** Tras cambiar cuenta / login (p. ej. retry review). */
		onafterauth = undefined as undefined | (() => void)
	}: {
		agentId?: string;
		agentLabel?: string;
		sessionId?: string;
		showActions?: boolean;
		refreshToken?: number;
		onaccount?: (loggedIn: boolean) => void;
		onafterauth?: () => void;
	} = $props();

	let busy = $state(false);
	let note = $state('');
	let err = $state('');
	let pickHost = $state(false);
	let enterpriseHost = $state('');
	let account = $state<{
		loggedIn: boolean;
		accountLabel: string | null;
		detail: string | null;
		source: string | null;
		warnings: string[];
	} | null>(null);

	const canSwitch = $derived(agentId === 'copilot' || agentId === 'claude');
	const loggedIn = $derived(Boolean(account?.loggedIn && account.accountLabel));
	const label = $derived(loggedIn ? account!.accountLabel! : 'Sin sesión');

	let generation = 0;

	function publishAccount() {
		onaccount?.(Boolean(account?.loggedIn && account.accountLabel));
	}

	async function refresh() {
		const gen = ++generation;
		const id = agentId;
		if (!id) {
			account = null;
			publishAccount();
			return;
		}
		try {
			const next = await agentAccount({ agentId: id });
			if (gen !== generation) return;
			account = next;
		} catch {
			if (gen !== generation) return;
			account = {
				loggedIn: false,
				accountLabel: null,
				detail: null,
				source: null,
				warnings: []
			};
		}
		publishAccount();
	}

	// Refetch al cambiar de agente o cuando el padre cierra/abre sesión.
	let fetchKey = '';
	$effect(() => {
		const key = `${agentId}\0${refreshToken}`;
		if (key === fetchKey) return;
		const agentChanged = !fetchKey.startsWith(`${agentId}\0`);
		fetchKey = key;
		if (agentChanged) {
			account = null;
			onaccount?.(false);
		}
		void refresh();
	});

	async function switchAccount() {
		if (!canSwitch || busy) return;
		busy = true;
		err = '';
		note = '';
		try {
			const result = await openAgentLogout({
				agentId,
				...(sessionId ? { id: sessionId } : {})
			});
			note = result.hint;
			if (result.warnings?.length) err = result.warnings.join(' ');
			await refresh();
			if (agentId === 'copilot') pickHost = true;
			else await startLogin('');
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function startLogin(host?: string | null) {
		if (!agentId || busy) return;
		pickHost = false;
		busy = true;
		err = '';
		note = 'Esperando que completes el inicio de sesión…';
		try {
			const result = await openAgentLogin({
				agentId,
				...(sessionId ? { id: sessionId } : {}),
				...(agentId === 'copilot' ? { host: host ?? '' } : {})
			});
			note = result.hint || (result.resumed ? 'Inicio de sesión ok.' : note);
			await refresh();
			if (result.resumed) onafterauth?.();
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	function onLoginClick() {
		if (agentId === 'copilot') pickHost = true;
		else void startLogin('');
	}
</script>

{#if agentId}
	<div
		class="account-strip"
		class:muted={!loggedIn}
		title={agentLabel
			? loggedIn
				? `${agentLabel} · ${label}${account?.detail ? ` (${account.detail})` : ''}`
				: `${agentLabel} · sin sesión`
			: undefined}
	>
		<div class="account-meta">
			<span class="account-label">{label}</span>
			{#if loggedIn && account?.detail}
				<span class="account-detail">{account.detail}</span>
			{/if}
		</div>

		{#if showActions}
			{#if pickHost && agentId === 'copilot'}
				<div class="host-pick">
					<button type="button" class="link" disabled={busy} onclick={() => void startLogin('')}>
						GitHub.com
					</button>
					<span class="sep" aria-hidden="true">·</span>
					<label class="host-field">
						<span class="sr-only">Enterprise hostname</span>
						<input
							type="text"
							bind:value={enterpriseHost}
							placeholder="empresa.ghe.com"
							autocomplete="off"
							disabled={busy}
						/>
					</label>
					<button
						type="button"
						class="link"
						disabled={busy || !enterpriseHost.trim()}
						onclick={() => void startLogin(enterpriseHost.trim())}
					>
						Enterprise
					</button>
					<span class="sep" aria-hidden="true">·</span>
					<button type="button" class="link dim" disabled={busy} onclick={() => (pickHost = false)}>
						Volver
					</button>
				</div>
			{:else if loggedIn}
				{#if canSwitch}
					<button type="button" class="link" disabled={busy} onclick={() => void switchAccount()}>
						{busy ? 'Esperando…' : 'Cambiar cuenta'}
					</button>
				{/if}
			{:else}
				<button type="button" class="link" disabled={busy} onclick={onLoginClick}>
					{busy ? 'Esperando…' : 'Iniciar sesión'}
				</button>
			{/if}
		{/if}

		{#if note}
			<p class="note">{note}</p>
		{/if}
		{#if err}
			<p class="err">{err}</p>
		{/if}
		{#if account?.warnings?.length}
			<p class="err">{account.warnings.join(' ')}</p>
		{/if}
	</div>
{/if}

<style>
	.account-strip {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 6px 10px;
		min-width: 0;
		font: inherit;
		color: var(--text);
	}

	.account-strip.muted {
		color: var(--text-dim);
	}

	.account-meta {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.account-label {
		font-size: 12.5px;
		font-weight: 550;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 160px;
	}

	.account-detail {
		font-size: 11px;
		color: var(--text-faint);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 180px;
	}

	.link {
		padding: 0;
		border: none;
		border-radius: 0;
		background: transparent;
		color: var(--accent);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.link:hover:not(:disabled) {
		color: var(--text);
	}

	.link:disabled {
		opacity: 0.55;
		cursor: default;
	}

	.link.dim {
		color: var(--text-dim);
		text-decoration: none;
	}

	.host-pick {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.host-field {
		display: inline-flex;
		min-width: 0;
	}

	.host-field input {
		width: 120px;
		max-width: 40vw;
		padding: 3px 6px;
		border: 1px solid var(--border);
		background: var(--bg);
		color: var(--text);
		font: inherit;
		font-size: 11.5px;
	}

	.sep {
		color: var(--text-faint);
		font-size: 11px;
	}

	.note,
	.err {
		flex: 1 1 100%;
		margin: 0;
		font-size: 11px;
		line-height: 1.35;
	}

	.note {
		color: var(--text-dim);
	}

	.err {
		color: var(--danger);
	}

	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>
