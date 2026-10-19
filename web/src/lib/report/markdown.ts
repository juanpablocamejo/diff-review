import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({
	gfm: true,
	breaks: true
});

/** Markdown del agente → HTML seguro para `{@html}`. */
export function renderAgentMarkdown(source: string): string {
	const raw = marked.parse(source || '', { async: false });
	return DOMPurify.sanitize(raw, {
		USE_PROFILES: { html: true }
	});
}
