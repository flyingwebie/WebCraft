import { type KeyboardEvent, type ReactNode, useRef } from "react";

import { CHROME_EASE, FOCUS_RING } from "../../controls.tsx";

/**
 * What the Forms place's tabs after Build draw with (`forms-builder/04`, `05`): settings cards (radius
 * 10, 14 in, raised on the chrome), the chrome's text boxes and wells, a switch, and the row of
 * language tabs a text is written in.
 */

/** A text box of the chrome: 30 high, the chrome's colour, a 1 px line, radius 6. */
export const INPUT_LOOK = `border-chrome-hover bg-chrome text-chrome-text placeholder:text-chrome-faint h-[30px] w-full min-w-0 rounded-md border px-2 text-[12px] ${CHROME_EASE} ${FOCUS_RING}`;

/** A longer text: a well, 74 high at least (`forms-builder/04`). */
export const WELL_LOOK = `border-chrome-hover bg-chrome-well text-chrome-text placeholder:text-chrome-faint min-h-[74px] w-full min-w-0 resize-y rounded-lg border p-2.5 text-[12px] leading-[1.45] ${CHROME_EASE} ${FOCUS_RING}`;

/** A settings card with its title (a heading of the tab). */
export function Card({ title, id, children }: { title: string; id?: string; children: ReactNode }) {
	return (
		<section
			aria-labelledby={id}
			className="border-chrome-hover bg-chrome-raised flex w-full flex-col gap-3 rounded-[10px] border p-3.5"
		>
			<h2 id={id} className="text-chrome-strong m-0 text-[13px] font-semibold">
				{title}
			</h2>
			{children}
		</section>
	);
}

/** A problem the server answered at a setting, under it. */
export function Problem({ id, children }: { id: string; children: ReactNode }) {
	if (!children) return null;
	return (
		<p id={id} className="text-chrome-danger m-0 text-[11px]">
			{children}
		</p>
	);
}

/** A switch of the chrome (`forms-builder/04`'s Time trap), named by `labelledBy`. */
export function Switch({
	on,
	labelledBy,
	onChange,
	disabled,
	...data
}: {
	on: boolean;
	labelledBy: string;
	onChange(on: boolean): void;
	disabled?: boolean;
	[data: `data-${string}`]: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={on}
			aria-labelledby={labelledBy}
			disabled={disabled}
			onClick={() => onChange(!on)}
			className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full disabled:opacity-60 ${
				on ? "bg-chrome-ok" : "bg-chrome-hover"
			} ${CHROME_EASE} ${FOCUS_RING}`}
			{...data}
		>
			<span
				aria-hidden="true"
				className={`absolute top-0.5 size-3 rounded-full ${on ? "bg-chrome end-0.5" : "bg-chrome-strong start-0.5"}`}
			/>
		</button>
	);
}

/**
 * The Site's languages as tabs over one text (`forms-builder/04`): the Default language writes the
 * text, the others its translations. Arrows, Home and End move between them; each controls `panel`.
 */
export function LanguageTabs({
	label,
	languages,
	current,
	panel,
	onChoose,
}: {
	label: string;
	languages: readonly { code: string; name: string }[];
	current: string;
	panel: string;
	onChoose(code: string): void;
}) {
	const list = useRef<HTMLDivElement>(null);
	const onKey = (event: KeyboardEvent<HTMLButtonElement>, at: number) => {
		const last = languages.length - 1;
		const next =
			event.key === "ArrowRight"
				? (at + 1) % languages.length
				: event.key === "ArrowLeft"
					? (at + last) % languages.length
					: event.key === "Home"
						? 0
						: event.key === "End"
							? last
							: null;
		if (next === null) return;
		event.preventDefault();
		const code = languages[next]?.code;
		if (!code) return;
		onChoose(code);
		requestAnimationFrame(() =>
			list.current?.querySelector<HTMLElement>(`[data-wc-language-tab="${CSS.escape(code)}"]`)?.focus(),
		);
	};
	return (
		<div ref={list} role="tablist" aria-label={label} className="flex flex-wrap items-center gap-1.5">
			{languages.map((language, at) => {
				const selected = language.code === current;
				return (
					<button
						key={language.code}
						type="button"
						role="tab"
						aria-selected={selected}
						aria-controls={selected ? panel : undefined}
						tabIndex={selected ? 0 : -1}
						onClick={() => onChoose(language.code)}
						onKeyDown={(event) => onKey(event, at)}
						className={`border-chrome-hover flex h-8 items-center rounded-[7px] border px-3 text-[12px] font-medium ${
							selected ? "bg-chrome-hover text-chrome-strong" : "text-chrome-muted hover:text-chrome-text"
						} ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-language-tab={language.code}
					>
						{language.name}
					</button>
				);
			})}
		</div>
	);
}

/** A link to the admin, in a new tab (what the building area leaves to it). */
export function AdminLink({
	href,
	children,
	...data
}: {
	href: string;
	children: ReactNode;
	[data: `data-${string}`]: string;
}) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className={`text-chrome-accent self-start rounded-sm text-[12px] font-medium underline-offset-2 hover:underline ${FOCUS_RING}`}
			{...data}
		>
			{children}
		</a>
	);
}
