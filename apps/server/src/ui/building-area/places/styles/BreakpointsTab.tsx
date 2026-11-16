import { PlusIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import type { Editing } from "../../../design-system/editing.ts";
import { freeName, newTokenId, type Tokens } from "../../../design-system/model.ts";
import { fill, type Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../controls.tsx";
import { canvasWidth, showBreakpoint, useShownBreakpoints } from "./canvas.ts";
import { RULER_TICKS, rulerAt, rulesFrom, STEP_NAME } from "./view.ts";

type Breakpoint = Tokens["breakpoints"][number];

/** A switch on the chrome (26 × 15), as the frames draw it. */
export function Switch({
	on,
	label,
	onChange,
	data,
}: {
	on: boolean;
	label: string;
	onChange(on: boolean): void;
	data?: Record<`data-${string}`, string>;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={on}
			aria-label={label}
			onClick={() => onChange(!on)}
			className={`inline-flex h-[15px] w-[26px] shrink-0 items-center rounded-full px-0.5 ${
				on ? "bg-chrome-ok justify-end" : "justify-start bg-zinc-600"
			} ${CHROME_EASE} ${FOCUS_RING}`}
			{...data}
		>
			<span aria-hidden="true" className={`size-[11px] rounded-full ${on ? "bg-green-950" : "bg-zinc-300"}`} />
		</button>
	);
}

/**
 * Styles › Breakpoints (`places-assets/07`): the Design system's breakpoints as a small table (name,
 * the query its styles apply from, how many Classes have styles from it up, and whether the canvas
 * shows its line), "Add Breakpoint", and the canvas-width ruler: 320 to 1920 px, a dot at each
 * breakpoint and a mark at the width of the page on the canvas now.
 */
export function BreakpointsTab({
	words,
	editing,
	announce,
}: {
	words: Words;
	editing: Editing;
	announce(text: string): void;
}) {
	const shown = words.styles.breakpoints;
	const id = useId();
	const { tokens } = editing.draft;
	const breakpoints = [...tokens.breakpoints].sort((a, b) => a.width - b.width);
	const onCanvas = useShownBreakpoints();
	const [width, setWidth] = useState(() => canvasWidth());

	useEffect(() => {
		const measure = () => setWidth(canvasWidth());
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, []);

	const setBreakpoints = (next: Breakpoint[]) => editing.setSection("tokens", { ...tokens, breakpoints: next });
	const change = (breakpointId: string | undefined, patch: Partial<Breakpoint>) =>
		setBreakpoints(tokens.breakpoints.map((each) => (each.id === breakpointId ? { ...each, ...patch } : each)));

	const add = () => {
		const widest = Math.max(0, ...tokens.breakpoints.map((each) => each.width));
		const made: Breakpoint = {
			id: newTokenId(),
			name: freeName("breakpoint", tokens.breakpoints),
			width: widest > 0 ? widest + 256 : 1024,
		};
		setBreakpoints([...tokens.breakpoints, made]);
		announce(fill(shown.added, { name: made.name }));
	};

	return (
		<section
			aria-label={words.styles.tabs.breakpoints}
			className="border-chrome-hover flex min-w-0 grow flex-col gap-7 overflow-auto rounded-[10px] border p-4"
			data-wc-breakpoints=""
		>
			<table className="w-full border-collapse text-start">
				<thead>
					<tr className="h-8">
						{[
							[shown.name, "w-40"],
							[shown.query, "w-[220px]"],
							[shown.usedIn, "w-[120px]"],
							[shown.showOnCanvas, ""],
						].map(([label, size]) => (
							<th
								key={label}
								scope="col"
								className={`text-chrome-muted px-1 text-start text-[11px] font-semibold uppercase ${size}`}
							>
								{label}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{breakpoints.map((breakpoint) => (
						<BreakpointRow
							key={breakpoint.id ?? breakpoint.name}
							words={words}
							breakpoint={breakpoint}
							rules={breakpoint.id ? rulesFrom(editing.draft.classes, breakpoint.id) : 0}
							shownOnCanvas={onCanvas.some((each) => each.id === breakpoint.id)}
							onChange={(patch) => change(breakpoint.id, patch)}
							onShow={(on) => {
								if (!breakpoint.id) return;
								showBreakpoint({ id: breakpoint.id, name: breakpoint.name, width: breakpoint.width }, on);
								announce(fill(on ? shown.shown : shown.hidden, { name: breakpoint.name }));
							}}
						/>
					))}
					<tr className="border-chrome-line h-10 border-t">
						<td colSpan={4} className="px-1">
							<button
								type="button"
								onClick={add}
								className={`text-chrome-muted hover:text-chrome-strong inline-flex items-center gap-1.5 rounded-sm text-[12px] font-medium ${CHROME_EASE} ${FOCUS_RING}`}
								data-wc-breakpoint-add=""
							>
								<PlusIcon aria-hidden="true" className="size-3.5" />
								{shown.add}
							</button>
						</td>
					</tr>
				</tbody>
			</table>
			<div className="flex flex-col gap-4 pt-2.5">
				<h2 id={`${id}-ruler`} className="text-chrome-muted m-0 text-[12px] font-semibold tracking-[0.4px] uppercase">
					{shown.canvasWidth}
				</h2>
				<div
					role="img"
					aria-labelledby={`${id}-ruler`}
					aria-describedby={`${id}-ruler-words`}
					className="relative mt-5 h-14 w-full max-w-[1024px]"
					data-wc-ruler=""
				>
					<span className="bg-chrome-hover absolute inset-x-0 top-6 h-0.5" />
					{RULER_TICKS.map((tick) => (
						<span key={tick}>
							<span
								className="bg-chrome-faint absolute top-[18px] h-3.5 w-px"
								style={{ left: `${rulerAt(tick) * 100}%` }}
							/>
							<span
								className="text-chrome-muted absolute top-9 w-14 -translate-x-1/2 text-center font-mono text-[10px]"
								style={{ left: `${rulerAt(tick) * 100}%` }}
							>
								{tick}
							</span>
						</span>
					))}
					{breakpoints.map((breakpoint) => (
						<span
							key={breakpoint.id ?? breakpoint.name}
							className="bg-condition absolute top-4 size-[7px] -translate-x-1/2 rounded-full ring-[1.5px] ring-white"
							style={{ left: `${rulerAt(breakpoint.width) * 100}%` }}
							data-wc-ruler-breakpoint={breakpoint.name}
						/>
					))}
					{width ? (
						<>
							<span
								className="bg-chrome-warn absolute top-0 h-6 w-0.5 -translate-x-1/2"
								style={{ left: `${rulerAt(width) * 100}%` }}
							/>
							<span
								className="absolute -top-5 flex h-[18px] -translate-x-1/2 items-center rounded-[5px] bg-blue-950 px-1.5 font-mono text-[11px] font-medium text-blue-200"
								style={{ left: `${rulerAt(width) * 100}%` }}
								data-wc-ruler-canvas={width}
							>
								{`${width}px`}
							</span>
						</>
					) : null}
				</div>
				<p id={`${id}-ruler-words`} className="sr-only">
					{[
						width ? fill(shown.canvasNow, { width: String(width) }) : shown.noCanvas,
						...breakpoints.map((each) => fill(shown.at, { name: each.name, width: String(each.width) })),
					].join(" ")}
				</p>
			</div>
		</section>
	);
}

/** One breakpoint's row: its name and width as fields (saved once valid), its use, its canvas switch. */
function BreakpointRow({
	words,
	breakpoint,
	rules,
	shownOnCanvas,
	onChange,
	onShow,
}: {
	words: Words;
	breakpoint: Breakpoint;
	rules: number;
	shownOnCanvas: boolean;
	onChange(patch: Partial<Breakpoint>): void;
	onShow(on: boolean): void;
}) {
	const shown = words.styles.breakpoints;
	const id = useId();
	const [name, setName] = useState(breakpoint.name);
	const [width, setWidth] = useState(String(breakpoint.width));
	const nameValid = STEP_NAME.test(name);
	const widthValue = Number(width);
	const widthValid = /^\d{2,4}$/.test(width) && widthValue >= 100 && widthValue <= 4000;
	const field =
		"text-chrome-text rounded-[5px] border border-transparent bg-transparent outline-none hover:border-chrome-hover focus:border-chrome-focus focus:ring-1 focus:ring-chrome-focus aria-invalid:border-chrome-danger";
	return (
		<tr className="border-chrome-line h-11 border-t" data-wc-breakpoint-row={breakpoint.name}>
			<td className="px-1">
				<input
					aria-label={fill(shown.nameOf, { name: breakpoint.name })}
					value={name}
					onChange={(event) => {
						setName(event.target.value);
						if (STEP_NAME.test(event.target.value)) onChange({ name: event.target.value });
					}}
					aria-invalid={nameValid ? undefined : true}
					aria-describedby={nameValid ? undefined : `${id}-name`}
					spellCheck={false}
					autoComplete="off"
					className={`h-7 w-36 px-1.5 text-[13px] font-medium ${field}`}
				/>
				{nameValid ? null : (
					<span id={`${id}-name`} className="sr-only">
						{shown.nameInvalid}
					</span>
				)}
			</td>
			<td className="text-chrome-muted px-1 font-mono text-[12px]">
				<span className="inline-flex items-center">
					<span className="pe-1">{"width >="}</span>
					<input
						aria-label={fill(shown.widthOf, { name: breakpoint.name })}
						inputMode="numeric"
						value={width}
						onChange={(event) => {
							const typed = event.target.value.replace(/[^0-9]/g, "").slice(0, 4);
							setWidth(typed);
							const value = Number(typed);
							if (/^\d{2,4}$/.test(typed) && value >= 100 && value <= 4000) onChange({ width: value });
						}}
						aria-invalid={widthValid ? undefined : true}
						className={`h-7 w-12 px-1 font-mono text-[12px] ${field}`}
						data-wc-breakpoint-width=""
					/>
					px
				</span>
			</td>
			<td className="text-chrome-muted px-1 text-[12px]">
				{rules === 1 ? shown.onRulesOne : fill(shown.onRules, { count: String(rules) })}
			</td>
			<td className="px-1">
				<Switch
					on={shownOnCanvas}
					label={fill(shown.showNamed, { name: breakpoint.name })}
					onChange={onShow}
					data={{ "data-wc-breakpoint-show": breakpoint.name }}
				/>
			</td>
		</tr>
	);
}
