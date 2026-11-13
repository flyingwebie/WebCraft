import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";

/** One tab: its id (unique on the page), its name, a short count beside it (`badge`), and its panel. */
export type TabSpec = { id: string; label: string; badge?: string; panel: ReactNode };

/**
 * Tabs, as the ARIA tabs pattern has them: a tab list (one tab stop; the arrow keys, Home and End move
 * between tabs and show each one's panel), then the panels. A panel stays mounted once shown, so what
 * was typed in it survives switching tabs. `onSelect` hears each change (to keep it in the address).
 */
export function Tabs({
	label,
	tabs,
	initial,
	onSelect,
	aside,
}: {
	/** What the tab list is, for screen readers. */
	label: string;
	tabs: readonly TabSpec[];
	initial?: string;
	onSelect?(id: string): void;
	/** What shows beside every panel, whichever tab is selected (a live preview). */
	aside?: ReactNode;
}) {
	const [selected, setSelected] = useState(() =>
		tabs.some((tab) => tab.id === initial) ? (initial as string) : (tabs[0]?.id ?? ""),
	);
	const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set([selected]));
	const list = useRef<HTMLDivElement>(null);
	const current = tabs.some((tab) => tab.id === selected) ? selected : (tabs[0]?.id ?? "");

	const choose = (id: string, focus: boolean) => {
		setSelected(id);
		setShown((before) => new Set([...before, id]));
		onSelect?.(id);
		if (focus) list.current?.querySelector<HTMLButtonElement>(`#tab-${id}`)?.focus();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		const index = tabs.findIndex((tab) => tab.id === current);
		// In a right-to-left page the arrow keys follow the reading direction.
		const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
		const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
		let next: number | undefined;
		if (step !== undefined) next = (index + step + tabs.length) % tabs.length;
		if (event.key === "Home") next = 0;
		if (event.key === "End") next = tabs.length - 1;
		const target = next === undefined ? undefined : tabs[next];
		if (!target) return;
		event.preventDefault();
		choose(target.id, true);
	};

	const panels = tabs.map((tab) => (
		// Every panel is there for its tab's aria-controls; its content comes the first time it shows.
		<div
			key={tab.id}
			role="tabpanel"
			id={`panel-${tab.id}`}
			aria-labelledby={`tab-${tab.id}`}
			hidden={tab.id !== current}
			className="min-w-0"
		>
			{shown.has(tab.id) || tab.id === current ? tab.panel : null}
		</div>
	));

	return (
		<div className="grid gap-6">
			<div ref={list} role="tablist" aria-label={label} className="flex flex-wrap gap-4 border-b">
				{tabs.map((tab) => (
					<button
						key={tab.id}
						type="button"
						role="tab"
						id={`tab-${tab.id}`}
						aria-selected={tab.id === current}
						aria-controls={`panel-${tab.id}`}
						tabIndex={tab.id === current ? 0 : -1}
						onClick={() => choose(tab.id, false)}
						onKeyDown={onKeyDown}
						className="focus-visible:ring-ring/50 aria-selected:border-primary aria-selected:text-foreground text-muted-foreground -mb-px rounded-t-sm border-b-2 border-transparent px-1 pb-2 text-sm font-medium outline-none focus-visible:ring-3"
					>
						{tab.label}
						{tab.badge ? (
							<span className="bg-muted text-muted-foreground ms-1.5 rounded-full px-1.5 py-0.5 text-xs font-medium">
								{tab.badge}
							</span>
						) : null}
					</button>
				))}
			</div>
			{aside ? (
				<div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
					<div className="min-w-0">{panels}</div>
					{aside}
				</div>
			) : (
				panels
			)}
		</div>
	);
}
