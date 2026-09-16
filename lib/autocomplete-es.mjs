/**
 * Autocomplete estilo Clack con etiquetas en español
 * ("Buscar:" en lugar de "Search:").
 */
import { AutocompletePrompt, settings } from '@clack/core';
import {
	S_BAR,
	S_BAR_END,
	S_RADIO_ACTIVE,
	S_RADIO_INACTIVE,
	limitOptions,
	symbol
} from '@clack/prompts';
import { styleText } from 'node:util';

function optionLabel(opt) {
	return opt.label ?? String(opt.value ?? '');
}

function defaultFilter(search, option) {
	const q = String(search || '').toLowerCase();
	if (!q) return true;
	const label = optionLabel(option).toLowerCase();
	const value = String(option.value ?? '').toLowerCase();
	const hint = String(option.hint ?? '').toLowerCase();
	return label.includes(q) || value.includes(q) || hint.includes(q);
}

/**
 * @template Value
 * @param {{
 *   message: string,
 *   options: Array<{ value: Value, label?: string, hint?: string, disabled?: boolean }>,
 *   initialValue?: Value,
 *   maxItems?: number,
 *   placeholder?: string,
 * }} opts
 * @returns {Promise<Value | symbol>}
 */
export function autocompleteEs(opts) {
	return new AutocompletePrompt({
		options: opts.options,
		initialValue: opts.initialValue !== undefined ? [opts.initialValue] : undefined,
		filter: defaultFilter,
		render() {
			const withGuide = settings.withGuide;
			const title = withGuide
				? [`${styleText('gray', S_BAR)}`, `${symbol(this.state)}  ${opts.message}`]
				: [`${symbol(this.state)}  ${opts.message}`];
			const input = this.userInput;
			const all = this.options;
			const placeholder = opts.placeholder;
			const showPlaceholder = input === '' && placeholder !== undefined;

			const styleOption = (opt, kind) => {
				const label = optionLabel(opt);
				const hint =
					opt.hint && opt.value === this.focusedValue ? styleText('dim', ` (${opt.hint})`) : '';
				switch (kind) {
					case 'active':
						return `${styleText('green', S_RADIO_ACTIVE)} ${label}${hint}`;
					case 'inactive':
						return `${styleText('dim', S_RADIO_INACTIVE)} ${styleText('dim', label)}`;
					case 'disabled':
						return `${styleText('gray', S_RADIO_INACTIVE)} ${styleText(['strikethrough', 'gray'], label)}`;
					default:
						return label;
				}
			};

			switch (this.state) {
				case 'submit': {
					const selected = this.selectedValues?.[0];
					const label =
						selected !== undefined
							? `  ${styleText('dim', optionLabel(all.find((o) => o.value === selected) || { value: selected }))}`
							: '';
					const bar = withGuide ? styleText('gray', S_BAR) : '';
					return `${title.join('\n')}\n${bar}${label}`;
				}
				case 'cancel': {
					const typed = input ? `  ${styleText(['strikethrough', 'dim'], input)}` : '';
					const bar = withGuide ? styleText('gray', S_BAR) : '';
					return `${title.join('\n')}\n${bar}${typed}`;
				}
				default: {
					const color = this.state === 'error' ? 'yellow' : 'cyan';
					const prefix = withGuide ? `${styleText(color, S_BAR)}  ` : '';
					const end = withGuide ? styleText(color, S_BAR_END) : '';

					let field = '';
					if (this.isNavigating || showPlaceholder) {
						const shown = showPlaceholder ? placeholder : input;
						field = shown !== '' ? ` ${styleText('dim', shown)}` : '';
					} else {
						field = ` ${this.userInputWithCursor}`;
					}

					const matchHint =
						this.filteredOptions.length !== all.length
							? styleText(
									'dim',
									` (${this.filteredOptions.length} coincidencia${this.filteredOptions.length === 1 ? '' : 's'})`
								)
							: '';

					const lines = [...title];
					if (withGuide) lines.push(`${prefix.trimEnd()}`);
					lines.push(`${prefix}${styleText('dim', 'Buscar:')}${field}${matchHint}`);

					if (this.filteredOptions.length === 0 && input) {
						lines.push(`${prefix}${styleText('yellow', 'Sin coincidencias')}`);
					}
					if (this.state === 'error') {
						lines.push(`${prefix}${styleText('yellow', this.error)}`);
					}

					const hints = [
						`${styleText('dim', '↑/↓')} elegir`,
						`${styleText('dim', 'Enter')} confirmar`,
						`${styleText('dim', 'Escribí')} para filtrar`
					];
					const footer = [`${prefix}${hints.join(' · ')}`, end];

					const options =
						this.filteredOptions.length === 0
							? []
							: limitOptions({
									cursor: this.cursor,
									options: this.filteredOptions,
									columnPadding: withGuide ? 3 : 0,
									rowPadding: lines.length + footer.length,
									style: (opt, active) =>
										styleOption(opt, opt.disabled ? 'disabled' : active ? 'active' : 'inactive'),
									maxItems: opts.maxItems
								});

					return [...lines, ...options.map((row) => `${prefix}${row}`), ...footer].join('\n');
				}
			}
		}
	}).prompt();
}
