<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		buildCommandText,
		buildCoveragePromptText,
		buildPrompt,
		buildSkillMarkdown,
		OUTPUT_FILENAME,
		skillFilename,
		type SkillAgent
	} from '$lib/report/prompts';
	import { uncoveredFiles } from '$lib/report/coverage';
	import { coerceDocument, hasUsableDiffs, parseReportMeta } from '$lib/report/document';
	import { hydrateFromGit, launchContext, loadRepo, pickLocalFolder } from '$lib/report/git.remote';
	import { deleteReport, loadLastMeta, loadReportsIndex, saveLastMeta, saveReport } from '$lib/report/storage';
	import { SAMPLE_DOCUMENT } from '$lib/report/sample';
	import type { ReportMeta, RepoSource, ReviewDocument, SavedReportSummary } from '$lib/report/types';
	import { validateDocument } from '$lib/report/validate';
	import ThemeToggle from '$lib/ThemeToggle.svelte';

	let meta = $state<ReportMeta>({ source: 'local', repo: '', branch: '', base: 'develop' });
	let promptText = $state('');
	let promptEdited = $state(false);
	let copied = $state(false);
	let promptViewMode = $state<'full' | 'command'>('full');
	let commandCopied = $state(false);

	let dragOver = $state(false);
	let dropErrors = $state<string[]>([]);
	// Documento válido pero incompleto: espera decisión del usuario antes de abrirse.
	let pendingDoc = $state<ReviewDocument | null>(null);
	let uncovered = $state<string[]>([]);
	let coverageCopied = $state(false);
	let reports = $state<SavedReportSummary[]>([]);
	let reportMenuId = $state<string | null>(null);

	let branches = $state<string[]>([]);
	let folderError = $state('');
	let loadingRepo = $state(false);
	let pickingFolder = $state(false);
	let hydrating = $state(false);
	/** Ruta local recordada al pasar a URL, para no perderla al volver. */
	let lastLocalRepo = $state('');

	let fileInput = $state<HTMLInputElement | null>(null);

	const commandText = $derived(buildCommandText(meta));

	onMount(() => {
		const last = loadLastMeta();
		meta = last;
		if (last.source === 'local' && looksLikePath(last.repo)) lastLocalRepo = last.repo.trim();
		promptText = buildPrompt(meta);
		reports = loadReportsIndex();
		void bootstrapFromLaunch(last);
	});

	/** Si se lanzó desde un repo git, precarga esa ruta y el branch actual. */
	async function bootstrapFromLaunch(last: ReportMeta) {
		try {
			const launch = await launchContext();
			if (launch?.repo) {
				const nextBranch =
					launch.current && launch.current !== 'HEAD'
						? launch.current
						: launch.branches[0] || '';
				const nextBase = launch.branches.includes(last.base) ? last.base : launch.defaultBase;
				branches = launch.branches;
				lastLocalRepo = launch.repo;
				updateMeta({
					source: 'local',
					repo: launch.repo,
					branch: nextBranch,
					base: nextBase,
					remoteUrl: launch.remoteUrl || undefined
				});
				return;
			}
		} catch {
			/* sin CWD git: seguir con last-meta */
		}
		if (last.repo.trim()) void loadRepoBranches(last.repo, last.source);
	}

	function updateMeta(patch: Partial<ReportMeta>) {
		meta = { ...meta, ...patch };
		if (meta.source === 'local' && looksLikePath(meta.repo)) {
			lastLocalRepo = meta.repo.trim();
		}
		saveLastMeta(meta);
		if (!promptEdited) promptText = buildPrompt(meta);
	}

	function setSource(source: RepoSource) {
		if (source === meta.source) return;
		branches = [];
		folderError = '';
		if (source === 'url') {
			if (looksLikePath(meta.repo)) lastLocalRepo = meta.repo.trim();
			const url =
				(meta.remoteUrl || '').trim() ||
				(looksLikeGitUrl(meta.repo) ? meta.repo.trim() : '');
			updateMeta({
				source,
				repo: url,
				...(url ? { remoteUrl: url } : {})
			});
			return;
		}
		const path = lastLocalRepo || (looksLikePath(meta.repo) ? meta.repo.trim() : '');
		const remote =
			(looksLikeGitUrl(meta.repo) ? meta.repo.trim() : '') || (meta.remoteUrl || '').trim();
		updateMeta({
			source,
			repo: path,
			...(remote ? { remoteUrl: remote } : {})
		});
	}

	function onPromptInput(e: Event) {
		promptText = (e.currentTarget as HTMLTextAreaElement).value;
		promptEdited = true;
	}

	function copyToClipboard(text: string, setDone: (v: boolean) => void) {
		const done = () => {
			setDone(true);
			setTimeout(() => setDone(false), 1600);
		};
		if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(done);
		else done();
	}

	function copyPrompt() {
		copyToClipboard(promptText, (v) => (copied = v));
	}

	function copyCoveragePrompt() {
		copyToClipboard(buildCoveragePromptText(meta, uncovered), (v) => (coverageCopied = v));
	}

	function copyCommand() {
		copyToClipboard(commandText, (v) => (commandCopied = v));
	}

	function downloadSkill(agent: SkillAgent) {
		const content = buildSkillMarkdown(agent);
		const blob = new Blob([content], { type: 'text/markdown' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = skillFilename(agent);
		a.click();
		URL.revokeObjectURL(url);
	}

	function looksLikePath(value: string) {
		return /[\\/]/.test(value) || /^[A-Za-z]:/.test(value);
	}

	function looksLikeGitUrl(value: string) {
		const v = value.trim();
		if (!v) return false;
		if (/^(https?:\/\/|git@|ssh:\/\/)/i.test(v)) return true;
		if (/\.git$/i.test(v) && !looksLikePath(v)) return true;
		return false;
	}

	function errMessage(err: unknown) {
		if (!err) return 'Error desconocido';
		if (typeof err === 'string') {
			try {
				const parsed = JSON.parse(err) as { message?: unknown };
				if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message;
			} catch {
				/* texto plano */
			}
			return err;
		}
		if (typeof err === 'object') {
			const rec = err as { message?: unknown; body?: { message?: unknown } };
			if (typeof rec.body?.message === 'string' && rec.body.message.trim()) return rec.body.message;
			if (typeof rec.message === 'string' && rec.message.trim()) {
				const msg = rec.message.trim();
				if (msg.startsWith('{')) {
					try {
						const parsed = JSON.parse(msg) as { message?: unknown };
						if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message;
					} catch {
						/* seguir con msg */
					}
				}
				return msg;
			}
		}
		return String(err);
	}

	async function browseLocalFolder() {
		if (pickingFolder || loadingRepo) return;
		pickingFolder = true;
		folderError = '';
		try {
			const path = await pickLocalFolder(null);
			if (!path) return;
			updateMeta({ source: 'local', repo: path });
			await loadRepoBranches(path, 'local');
		} catch (err) {
			folderError = 'No se pudo elegir la carpeta: ' + errMessage(err);
		} finally {
			pickingFolder = false;
		}
	}

	async function loadRepoBranches(path = meta.repo, source = meta.source) {
		const repo = path.trim();
		if (!repo) {
			folderError =
				source === 'url' ? 'Indicá la URL del repo.' : 'Indicá la ruta absoluta del repo.';
			return;
		}
		if (loadingRepo) return;
		loadingRepo = true;
		folderError = '';
		try {
			const result = await loadRepo({ source, repo });
			const nextBranch = result.branches.includes(meta.branch)
				? meta.branch
				: result.current || result.branches[0] || '';
			const nextBase = result.branches.includes(meta.base) ? meta.base : result.defaultBase;
			branches = result.branches;
			updateMeta({
				source: result.source,
				repo: result.repo,
				branch: nextBranch,
				base: nextBase,
				remoteUrl: result.remoteUrl || (result.source === 'url' ? result.repo : meta.remoteUrl)
			});
		} catch (err) {
			branches = [];
			folderError = 'No se pudo leer el repo: ' + errMessage(err);
		} finally {
			loadingRepo = false;
		}
	}

	function onDragOver(e: DragEvent) {
		e.preventDefault();
		if (!dragOver) dragOver = true;
	}
	function onDragLeave(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
	}
	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		if (hydrating) return;
		const file = e.dataTransfer?.files?.[0];
		if (file) handleFile(file);
	}
	function triggerFileInput() {
		if (hydrating) return;
		fileInput?.click();
	}
	function onFileInputChange(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (file) handleFile(file);
		input.value = '';
	}

	function handleFile(file: File) {
		const reader = new FileReader();
		reader.onload = () => {
			let raw: unknown;
			try {
				raw = JSON.parse(String(reader.result));
			} catch (err) {
				dropErrors = ['El archivo no es JSON válido: ' + errMessage(err)];
				return;
			}
			void ingestPayload(raw);
		};
		reader.onerror = () => {
			dropErrors = ['No se pudo leer el archivo.'];
		};
		reader.readAsText(file);
	}

	function payloadMeta(raw: unknown): ReportMeta {
		return parseReportMeta(raw, meta);
	}

	async function ingestPayload(raw: unknown) {
		const errors = validateDocument(raw);
		if (errors.length) {
			dropErrors = errors;
			return;
		}

		let doc = coerceDocument(raw);
		const ctx = payloadMeta(raw);

		// Autocompletar el formulario con lo que vino en el JSON.
		if (ctx.repo || ctx.branch || ctx.base || ctx.remoteUrl) {
			updateMeta({
				source: ctx.source,
				repo: ctx.repo || meta.repo,
				branch: ctx.branch || meta.branch,
				base: ctx.base || meta.base,
				remoteUrl: ctx.remoteUrl || meta.remoteUrl
			});
		}

		const payload = {
			intent: doc.intent,
			groups: doc.groups,
			blocks: doc.blocks,
			findings: doc.findings,
			skipped: doc.skipped,
			notes: doc.notes
		};

		type Attempt = { source: RepoSource; repo: string };
		const attempts: Attempt[] = [];
		const pushAttempt = (source: RepoSource, repo: string) => {
			const r = repo.trim();
			if (!r) return;
			if (attempts.some((a) => a.source === source && a.repo === r)) return;
			attempts.push({ source, repo: r });
		};

		if (ctx.branch) {
			if (ctx.source === 'local' && looksLikePath(ctx.repo)) pushAttempt('local', ctx.repo);
			else if (ctx.source === 'url' && looksLikeGitUrl(ctx.repo)) pushAttempt('url', ctx.repo);
			else if (looksLikeGitUrl(ctx.repo)) pushAttempt('url', ctx.repo);
			else if (looksLikePath(ctx.repo)) pushAttempt('local', ctx.repo);

			const remote = (ctx.remoteUrl || '').trim();
			if (remote && looksLikeGitUrl(remote)) pushAttempt('url', remote);
		}

		if (attempts.length && ctx.branch) {
			hydrating = true;
			dropErrors = [];
			const errors: string[] = [];
			let hydrated = false;
			let discoveredRemote = ctx.remoteUrl;
			try {
				for (const attempt of attempts) {
					try {
						doc = await hydrateFromGit({
							repo: attempt.repo,
							branch: ctx.branch,
							base: ctx.base || 'develop',
							source: attempt.source,
							payload
						});
						hydrated = true;
						if (attempt.source === 'url') {
							discoveredRemote = discoveredRemote || attempt.repo;
						} else if (!discoveredRemote) {
							try {
								const info = await loadRepo({ source: 'local', repo: attempt.repo });
								if (info.remoteUrl) discoveredRemote = info.remoteUrl;
							} catch {
								/* sin remote */
							}
						}
						break;
					} catch (err) {
						errors.push(`${attempt.source === 'url' ? 'URL' : 'local'}: ${errMessage(err)}`);
					}
				}
				if (!hydrated) {
					if (!hasUsableDiffs(doc)) {
						dropErrors = [
							'No se pudo calcular el diff con git.',
							...errors.map((e) => `· ${e}`)
						];
						return;
					}
					doc = {
						...doc,
						notes: [...doc.notes, 'No se pudo refrescar el diff con git: ' + errors.join(' | ')]
					};
				}
			} finally {
				hydrating = false;
			}

			if (discoveredRemote) {
				updateMeta({ remoteUrl: discoveredRemote });
			}

			const reportMeta: ReportMeta = {
				source: ctx.source,
				repo: ctx.repo || meta.repo,
				branch: ctx.branch || meta.branch,
				base: ctx.base || meta.base,
				remoteUrl: discoveredRemote || meta.remoteUrl
			};

			const missing = uncoveredFiles(doc);
			if (missing.length) {
				pendingDoc = doc;
				uncovered = missing;
				dropErrors = [];
				updateMeta(reportMeta);
				return;
			}
			openNewReport(doc, reportMeta);
			return;
		} else if (!hasUsableDiffs(doc)) {
			dropErrors = [
				'Indicá repo (ruta o URL) y branch, o incluí meta.remoteUrl en el JSON, para calcular el diff con git.'
			];
			return;
		}

		const reportMeta: ReportMeta = {
			source: ctx.source,
			repo: ctx.repo || meta.repo,
			branch: ctx.branch || meta.branch,
			base: ctx.base || meta.base,
			remoteUrl: ctx.remoteUrl || meta.remoteUrl
		};

		const missing = uncoveredFiles(doc);
		if (missing.length) {
			pendingDoc = doc;
			uncovered = missing;
			dropErrors = [];
			updateMeta(reportMeta);
			return;
		}
		openNewReport(doc, reportMeta);
	}

	function openNewReport(doc: ReviewDocument, reportMeta = meta) {
		dropErrors = [];
		pendingDoc = null;
		uncovered = [];
		const saved = saveReport(doc, reportMeta);
		void goto(resolve(`/report/${saved.id}`));
	}

	function loadSample() {
		openNewReport(SAMPLE_DOCUMENT, {
			source: 'local',
			repo: 'ms-obe-aprobacion-debin',
			branch: 'feature/PCM-14839',
			base: 'develop'
		});
	}

	function fmtWhen(iso: string) {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
	}

	function toggleReportMenu(id: string) {
		reportMenuId = reportMenuId === id ? null : id;
	}

	function removeReport(item: SavedReportSummary) {
		const label = item.branch || 'este reporte';
		if (!confirm(`¿Eliminar “${label}”? No se puede deshacer.`)) return;
		deleteReport(item.id);
		reports = loadReportsIndex();
		reportMenuId = null;
	}
</script>

<svelte:window
	onclick={() => {
		if (reportMenuId) reportMenuId = null;
	}}
	onkeydown={(e) => {
		if (e.key === 'Escape') reportMenuId = null;
	}}
/>

<div class="page">
	<header class="topbar">
		<a href={resolve('/')} class="brand">
			<span class="brand-dot"></span>
			<span class="title-block">
				<span>diff-review</span>
				<small>generá un prompt, corré tu agente, soltá el resultado</small>
			</span>
		</a>
		<ThemeToggle />
	</header>

	<div class="workspace">
		<section class="setup">
			<h2>1. Contexto</h2>
			<div class="mode-toggle source-toggle">
				<button type="button" class:on={meta.source === 'local'} onclick={() => setSource('local')}
					>Carpeta local</button
				>
				<button type="button" class:on={meta.source === 'url'} onclick={() => setSource('url')}
					>URL remota</button
				>
			</div>
			<p class="hint-text">
				{#if meta.source === 'url'}
					URL del remote (https / SSH). Al cargar se listan branches con <code>ls-remote</code>; al soltar el
					JSON se hace un clone shallow temporal para armar el diff. Requiere que el branch esté en el remote.
				{:else}
					Carpeta local del repo. Podés pegar la ruta o elegirla con el diálogo del sistema. Git corre ahí
					mismo (sirve para branches no pusheados).
				{/if}
			</p>
			{#if folderError}
				<p class="error-line">{folderError}</p>
			{/if}
			{#if branches.length}
				<p class="ok-line">{branches.length} branch{branches.length === 1 ? '' : 'es'} encontrado{branches.length === 1 ? '' : 's'}.</p>
			{/if}
			<div class="repo-setup">
				<label class="field repo-field">
					<span>{meta.source === 'url' ? 'URL del repo' : 'Repo'}</span>
					<div class="repo-row">
						<input
							type="text"
							placeholder={meta.source === 'url'
								? 'https://github.com/org/repo.git'
								: 'C:\\path\\to\\repo'}
							value={meta.repo}
							oninput={(e) => updateMeta({ repo: (e.currentTarget as HTMLInputElement).value })}
							onkeydown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									void loadRepoBranches();
								}
							}}
						/>
						{#if meta.source === 'local'}
							<button type="button" onclick={() => void browseLocalFolder()} disabled={pickingFolder || loadingRepo}>
								{pickingFolder ? 'Eligiendo…' : 'Elegir…'}
							</button>
						{/if}
						<button type="button" onclick={() => void loadRepoBranches()} disabled={loadingRepo || pickingFolder}>
							{loadingRepo ? 'Cargando…' : 'Cargar'}
						</button>
					</div>
				</label>
				<div class="row branches-row">
					<label class="field">
						<span>Branch a revisar</span>
						{#if branches.length}
							<select
								value={meta.branch}
								onchange={(e) => updateMeta({ branch: (e.currentTarget as HTMLSelectElement).value })}
							>
								{#each branches as b (b)}
									<option value={b}>{b}</option>
								{/each}
							</select>
						{:else}
							<input
								type="text"
								placeholder="feature/PCM-14839"
								value={meta.branch}
								oninput={(e) => updateMeta({ branch: (e.currentTarget as HTMLInputElement).value })}
							/>
						{/if}
					</label>
					<label class="field">
						<span>Base</span>
						{#if branches.length}
							<select
								value={meta.base}
								onchange={(e) => updateMeta({ base: (e.currentTarget as HTMLSelectElement).value })}
							>
								{#each branches as b (b)}
									<option value={b}>{b}</option>
								{/each}
							</select>
						{:else}
							<input
								type="text"
								placeholder="develop"
								value={meta.base}
								oninput={(e) => updateMeta({ base: (e.currentTarget as HTMLInputElement).value })}
							/>
						{/if}
					</label>
				</div>
			</div>

			<div class="section-head">
				<h2>2. Prompt</h2>
			</div>
			<div class="mode-toggle">
				<button type="button" class:on={promptViewMode === 'full'} onclick={() => (promptViewMode = 'full')}
					>Prompt completo</button
				>
				<button type="button" class:on={promptViewMode === 'command'} onclick={() => (promptViewMode = 'command')}
					>Comando (skill)</button
				>
			</div>

			{#if promptViewMode === 'full'}
				<p class="hint-text">Copiá esto en Claude, Cursor, Copilot o el agente que uses. El schema de salida va incluido.</p>
				<textarea value={promptText} oninput={onPromptInput}></textarea>
				<div class="actions">
					<button type="button" class="primary" onclick={copyPrompt}>{copied ? 'Copiado ✓' : 'Copiar prompt'}</button>
					<button type="button" class="ghost" onclick={loadSample}>Ver ejemplo</button>
				</div>
			{:else}
				<p class="hint-text">Necesita el skill instalado (abajo). El agente ya tiene guardadas las reglas y el schema de salida.</p>
				<div class="command-box"><code>{commandText}</code></div>
				<div class="actions">
					<button type="button" class="primary" onclick={copyCommand}
						>{commandCopied ? 'Copiado ✓' : 'Copiar comando'}</button
					>
				</div>
				<div class="skill-block">
					<h3>¿No tenés el skill instalado?</h3>
					<p class="hint-text">Define /diff-review y /diff-review-fix. Descargalo e instalalo en la carpeta indicada.</p>
					<div class="skill-buttons">
						<button type="button" onclick={() => downloadSkill('claude')}>Claude Code · .claude/commands/</button>
						<button type="button" onclick={() => downloadSkill('cursor')}>Cursor · .cursor/commands/</button>
						<button type="button" onclick={() => downloadSkill('copilot')}>Copilot · .github/prompts/</button>
					</div>
				</div>
			{/if}

			<h2 class="result-head">3. Resultado</h2>
			<p class="hint-text"
				>Soltá acá el <code>{OUTPUT_FILENAME}</code> que generó el agente. Si trae <code>meta</code>, se
				autocompletan repo y branches.</p
			>
			<div
				class="dropzone"
				class:drag={dragOver}
				class:busy={hydrating}
				ondragover={onDragOver}
				ondragleave={onDragLeave}
				ondrop={onDrop}
				role="presentation"
			>
				<p>{hydrating ? 'Calculando diff con git…' : 'Arrastrá el archivo .json acá'}</p>
				<button type="button" onclick={triggerFileInput} disabled={hydrating}>Elegir archivo</button>
				<input
					type="file"
					accept="application/json,.json"
					bind:this={fileInput}
					onchange={onFileInputChange}
					class="visually-hidden"
				/>
			</div>
			{#if pendingDoc}
				<div class="coverage-box">
					<div class="coverage-head">
						<strong>El modelo dejó {uncovered.length} archivo(s) sin explicar</strong>
						<span>no aparecen ni en "blocks" ni en "skipped"</span>
					</div>
					<details>
						<summary>Ver los archivos</summary>
						<ul class="coverage-list">
							{#each uncovered as path (path)}
								<li>{path}</li>
							{/each}
						</ul>
					</details>
					<p class="hint-text">
						Pasale este prompt al mismo agente que corrió la review: tiene el diff en contexto y solo
						tiene que completar lo que falta. Después soltá de nuevo el <code>{OUTPUT_FILENAME}</code>.
					</p>
					<textarea readonly rows="7" value={buildCoveragePromptText(meta, uncovered)}></textarea>
					<div class="coverage-actions">
						<button type="button" class="primary" onclick={copyCoveragePrompt}>
							{coverageCopied ? 'Copiado ✓' : 'Copiar prompt de corrección'}
						</button>
						<button type="button" onclick={() => pendingDoc && openNewReport(pendingDoc)}>Abrir igual</button>
					</div>
				</div>
			{/if}

			{#if dropErrors.length}
				<div class="drop-errors">
					<strong>No se pudo abrir el reporte:</strong>
					<ul>
						{#each dropErrors as err (err)}
							<li>{err}</li>
						{/each}
					</ul>
				</div>
			{/if}
		</section>

		<aside class="reports-col">
			<h2>Reportes anteriores</h2>
			{#if reports.length}
				<ul class="report-list">
					{#each reports as item (item.id)}
						<li class="report-item">
							<a class="report-card" href={resolve(`/report/${item.id}`)}>
								<span class="report-top">
									<strong>{item.branch || '—'}</strong>
									<span class="when">{fmtWhen(item.savedAt)}</span>
								</span>
								<span class="report-meta">
									<span>vs {item.base || 'develop'}</span>
									<span class="pill">{item.groupCount} tema{item.groupCount === 1 ? '' : 's'}</span>
									{#if item.blockerCount}
										<span class="pill bad">{item.blockerCount} blocker{item.blockerCount === 1 ? '' : 's'}</span>
									{/if}
									{#if item.qualityCount}
										<span class="pill">{item.qualityCount} calidad</span>
									{/if}
								</span>
								{#if item.intent}
									<p class="report-intent">{item.intent}</p>
								{/if}
							</a>
							<div class="report-actions">
								<button
									type="button"
									class="kebab"
									title="Más acciones"
									aria-label="Más acciones para {item.branch || 'reporte'}"
									aria-expanded={reportMenuId === item.id}
									aria-haspopup="menu"
									onclick={(e) => {
										e.preventDefault();
										e.stopPropagation();
										toggleReportMenu(item.id);
									}}
								>
									<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
										<circle cx="8" cy="3.5" r="1.25" fill="currentColor" />
										<circle cx="8" cy="8" r="1.25" fill="currentColor" />
										<circle cx="8" cy="12.5" r="1.25" fill="currentColor" />
									</svg>
								</button>
								{#if reportMenuId === item.id}
									<div class="report-menu" role="menu" tabindex="-1">
										<button
											type="button"
											class="menu-item danger"
											role="menuitem"
											onclick={(e) => {
												e.stopPropagation();
												removeReport(item);
											}}
										>
											Eliminar…
										</button>
									</div>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="hint-text">Todavía no hay reportes. Generá un prompt, corré tu agente y soltá el JSON.</p>
			{/if}
		</aside>
	</div>
</div>

<style>
	.page {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}

	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 16px 28px;
		border-bottom: 1px solid var(--border);
		background: var(--header-bg);
		position: sticky;
		top: 0;
		z-index: 5;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
		text-decoration: none;
		color: var(--text);
	}

	.brand-dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: linear-gradient(135deg, #6ea8fe, #c9a5ff);
		box-shadow: 0 0 12px #6ea8fe88;
		flex-shrink: 0;
	}

	.title-block {
		display: flex;
		flex-direction: column;
		line-height: 1.25;
		text-align: left;
	}

	.title-block span:first-child {
		font-weight: 700;
		font-size: 15px;
	}

	.title-block small {
		color: var(--text-faint);
		font-weight: 400;
		font-size: 11.5px;
	}

	.workspace {
		flex: 1;
		overflow: auto;
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(300px, 380px);
		gap: 28px;
		padding: 22px 28px 40px;
		max-width: 1280px;
		align-items: start;
		margin: 0 auto;
		width: 100%;
	}

	.setup {
		min-width: 0;
	}

	h2 {
		margin: 0 0 4px;
		font-size: 13px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
		font-weight: 600;
	}

	.result-head {
		margin-top: 24px;
	}

	.section-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin-top: 22px;
	}

	.link {
		background: transparent;
		border: 0;
		color: var(--accent);
		font-size: 12px;
		padding: 0;
	}

	.hint-text {
		margin: 0 0 12px;
		font-size: 12.5px;
		color: var(--text-dim);
		line-height: 1.5;
	}

	.hint-text code {
		font-family: var(--mono);
		font-size: 12px;
		color: var(--text);
	}

	.error-line {
		margin: 0 0 10px;
		font-size: 12px;
		color: var(--danger);
	}

	.ok-line {
		margin: 0 0 10px;
		font-size: 12px;
		color: var(--ok);
	}

	.row {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.repo-setup {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex: 1;
		min-width: 180px;
	}

	.repo-field {
		flex: none;
		width: 100%;
		min-width: 0;
	}

	.branches-row .field {
		flex: 1;
		min-width: 160px;
	}

	.field span {
		font-size: 11px;
		color: var(--text-faint);
	}

	.repo-row {
		display: flex;
		gap: 6px;
		min-width: 0;
	}

	.repo-row input[type='text'] {
		flex: 1;
		min-width: 0;
	}

	.repo-row button {
		flex-shrink: 0;
	}

	.source-toggle {
		margin-bottom: 10px;
	}

	input[type='text'],
	select {
		flex: 1;
		min-width: 0;
		background: var(--bg-card);
		border: 1px solid var(--border);
		padding: 9px 12px;
	}

	button {
		background: var(--bg-card);
		border: 1px solid var(--border);
		padding: 9px 12px;
		font-size: 12.5px;
		color: var(--text);
	}

	button:hover:not(:disabled) {
		border-color: var(--accent);
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.mode-toggle {
		display: flex;
		border: 1px solid var(--border);
		overflow: hidden;
		width: fit-content;
		margin-bottom: 10px;
	}

	.mode-toggle button {
		padding: 6px 12px;
		font-size: 12px;
		border: 0;
		background: transparent;
	}

	.mode-toggle button + button {
		border-left: 1px solid var(--border);
	}

	.mode-toggle button.on {
		background: var(--accent-soft);
	}

	textarea {
		width: 100%;
		height: 220px;
		resize: vertical;
		background: var(--bg);
		border: 1px solid var(--border);
		padding: 12px;
		font-family: var(--mono);
		font-size: 12px;
		line-height: 1.5;
		color: var(--text);
	}

	.command-box {
		background: var(--bg);
		border: 1px solid var(--border);
		padding: 10px 12px;
		overflow: auto;
	}

	.command-box code {
		font-family: var(--mono);
		font-size: 12.5px;
		color: var(--text);
		white-space: nowrap;
	}

	.actions {
		display: flex;
		gap: 8px;
		margin-top: 10px;
	}

	button.primary {
		background: var(--btn-primary-bg);
		border-color: var(--btn-primary-border);
		color: var(--btn-primary-text);
		font-weight: 600;
	}

	button.ghost {
		background: transparent;
		color: var(--text-dim);
	}

	.skill-block {
		margin-top: 16px;
		padding-top: 14px;
		border-top: 1px solid var(--border);
	}

	.skill-block h3 {
		margin: 0 0 4px;
		font-size: 11.5px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-faint);
		font-weight: 650;
	}

	.skill-buttons {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.coverage-box {
		margin-top: 12px;
		border: 1px solid var(--border);
		border-left: 3px solid var(--sev-med);
		background: var(--bg-card);
		padding: 12px 14px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.coverage-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 8px;
	}

	.coverage-head strong {
		font-size: 13px;
		color: var(--sev-med);
	}

	.coverage-head span {
		font-size: 11.5px;
		color: var(--text-faint);
	}

	.coverage-box summary {
		font-size: 12px;
		color: var(--text-dim);
		cursor: pointer;
	}

	.coverage-list {
		margin: 8px 0 0;
		padding-left: 18px;
		max-height: 180px;
		overflow: auto;
		font-family: var(--mono);
		font-size: 11px;
		color: var(--text-faint);
	}

	.coverage-box textarea {
		width: 100%;
		resize: vertical;
		background: var(--bg);
		border: 1px solid var(--border);
		padding: 10px;
		font-family: var(--mono);
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--text);
	}

	.coverage-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.dropzone {
		padding: 26px;
		border: 1.5px dashed var(--border);
		text-align: center;
		background: var(--bg-elev);
		transition:
			background 0.15s,
			border-color 0.15s;
	}

	.dropzone.drag {
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	.dropzone.busy {
		opacity: 0.7;
	}

	.dropzone p {
		margin: 0 0 6px;
		font-size: 14px;
		color: var(--text-dim);
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}

	.drop-errors {
		margin-top: 10px;
		padding: 10px 12px;
		background: var(--danger-bg);
		color: var(--danger);
		font-size: 12.5px;
	}

	.drop-errors strong {
		display: block;
		margin-bottom: 4px;
	}

	.drop-errors ul {
		margin: 0;
		padding-left: 18px;
		line-height: 1.6;
	}

	.reports-col {
		position: sticky;
		top: 88px;
		max-height: calc(100vh - 110px);
		overflow: auto;
		min-width: 0;
	}

	.report-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.report-item {
		position: relative;
		display: flex;
		align-items: stretch;
		border: 1px solid var(--border);
		background: var(--bg-card);
	}

	.report-item:hover {
		border-color: #33507a;
		background: var(--bg-card-hover);
	}

	.report-card {
		display: block;
		flex: 1;
		min-width: 0;
		padding: 12px 8px 12px 14px;
		text-decoration: none;
		color: var(--text);
	}

	.report-actions {
		position: relative;
		flex-shrink: 0;
		padding: 8px 8px 0 0;
	}

	.kebab {
		width: 26px;
		height: 26px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid transparent;
		background: transparent;
		color: var(--text-faint);
		padding: 0;
		cursor: pointer;
	}

	.kebab:hover {
		border-color: var(--border);
		color: var(--text);
		background: var(--bg);
	}

	.report-menu {
		position: absolute;
		top: calc(100% - 2px);
		right: 8px;
		z-index: 20;
		min-width: 140px;
		padding: 4px;
		border: 1px solid var(--border);
		background: var(--bg-card);
		box-shadow: 0 8px 24px color-mix(in srgb, #000 18%, transparent);
	}

	.report-menu .menu-item {
		display: block;
		width: 100%;
		padding: 8px 10px;
		border: 0;
		background: transparent;
		color: var(--text);
		font-size: 12.5px;
		text-align: left;
		cursor: pointer;
	}

	.report-menu .menu-item:hover {
		background: var(--accent-soft);
	}

	.report-menu .menu-item.danger {
		color: var(--danger);
	}

	.report-top {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		align-items: baseline;
	}

	.report-top strong {
		font-size: 14px;
	}

	.when {
		font-size: 12px;
		color: var(--text-dim);
	}

	.report-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
		margin-top: 6px;
		font-size: 12px;
		color: var(--text-dim);
	}

	.pill {
		font-family: var(--mono);
		font-size: 11px;
	}

	.pill.bad {
		color: var(--danger);
	}

	.report-intent {
		margin: 8px 0 0;
		font-size: 12.5px;
		color: var(--text-dim);
		line-height: 1.45;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	@media (max-width: 960px) {
		.workspace {
			grid-template-columns: 1fr;
		}

		.reports-col {
			position: static;
			max-height: none;
		}
	}
</style>
