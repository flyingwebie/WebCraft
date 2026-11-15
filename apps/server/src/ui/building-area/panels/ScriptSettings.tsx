import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { type KeyboardEvent, type RefObject, useEffect, useId, useRef, useState } from "react";

import type { Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";

/** The Consent categories a Component script can be in, in the Consent banner's order. */
export const CONSENT_CATEGORIES = ["necessary", "analytics", "marketing", "media"] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

/** What a Component script declares besides its code: its Consent category and the Libraries it needs. */
export type ScriptSettings = { consentCategory: ConsentCategory; libraryIds: string[] };

/** Whether two sets of settings say the same (the Libraries in any order). */
export function sameSettings(one: ScriptSettings, other: ScriptSettings): boolean {
	return (
		one.consentCategory === other.consentCategory &&
		one.libraryIds.length === other.libraryIds.length &&
		one.libraryIds.every((id) => other.libraryIds.includes(id))
	);
}

/**
 * The Component tab's settings (BA-36): one compact row under the JS pane's header, so the box keeps its
 * room. The **Consent category** (Code mode's four choices; its help shows on hover and focus, and is the
 * select's description) and the **Libraries it needs**, the Site's Libraries chosen several from a menu
 * of check items that stays open while they are ticked. Each change is handed over at once: the pane
 * saves it with the script.
 */
export function ScriptSettingsRow({
	words,
	settings,
	libraries,
	onChange,
}: {
	words: Words;
	settings: ScriptSettings;
	libraries: readonly { id: string; name: string }[];
	onChange(next: ScriptSettings): void;
}) {
	const shown = words.code.js;
	const consentId = useId();
	const helpId = useId();
	const librariesLabel = useId();
	const librariesValue = useId();
	const menuId = useId();
	const button = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const chosen = libraries.filter((library) => settings.libraryIds.includes(library.id)).map((each) => each.name);
	const control = `bg-chrome-raised text-chrome-strong hover:bg-chrome-hover h-6 min-w-0 rounded-[5px] border-0 text-[11px] font-medium ${CHROME_EASE} ${FOCUS_RING}`;

	return (
		<fieldset
			className="m-0 flex h-7 min-w-0 shrink-0 items-center gap-3 border-0 px-1 py-0"
			data-wc-script-settings=""
		>
			<legend className="sr-only">{shown.settings}</legend>
			<span className="group relative flex min-w-0 items-center gap-1.5">
				<label htmlFor={consentId} className="text-chrome-muted shrink-0 text-[11px] whitespace-nowrap">
					{shown.consent}
				</label>
				<span className="relative flex min-w-0 items-center">
					<select
						id={consentId}
						aria-describedby={helpId}
						value={settings.consentCategory}
						onChange={(event) => onChange({ ...settings, consentCategory: event.target.value as ConsentCategory })}
						className={`${control} cursor-pointer appearance-none ps-2 pe-6 [color-scheme:dark]`}
						data-wc-script-consent=""
					>
						{CONSENT_CATEGORIES.map((category) => (
							<option key={category} value={category}>
								{shown.categories[category]}
							</option>
						))}
					</select>
					<ChevronDownIcon
						aria-hidden="true"
						className="text-chrome-muted pointer-events-none absolute end-1.5 size-3"
					/>
				</span>
				<span id={helpId} className="sr-only">
					{shown.consentHelp}
				</span>
				<span
					aria-hidden="true"
					data-wc-tip=""
					className="border-chrome-hover bg-chrome-tip text-chrome-strong pointer-events-none absolute start-0 top-[calc(100%+6px)] z-40 hidden w-72 rounded-md border px-2 py-1 text-[11px] leading-4 font-medium shadow-[0_6px_16px_rgba(0,0,0,0.5)] group-focus-within:block group-hover:block"
				>
					{shown.consentHelp}
				</span>
			</span>
			<span className="relative flex min-w-0 items-center gap-1.5">
				<span id={librariesLabel} className="text-chrome-muted shrink-0 text-[11px] whitespace-nowrap">
					{shown.libraries}
				</span>
				<button
					ref={button}
					type="button"
					aria-haspopup="menu"
					aria-expanded={open}
					aria-controls={open ? menuId : undefined}
					aria-labelledby={`${librariesLabel} ${librariesValue}`}
					onClick={() => setOpen((was) => !was)}
					onKeyDown={(event) => {
						if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
						event.preventDefault();
						setOpen(true);
					}}
					className={`${control} inline-flex max-w-56 items-center gap-1 ps-2 pe-1.5`}
					data-wc-script-libraries=""
				>
					<span id={librariesValue} className="min-w-0 truncate">
						{chosen.length ? chosen.join(", ") : shown.librariesNone}
					</span>
					<ChevronDownIcon aria-hidden="true" className="text-chrome-muted size-3 shrink-0" />
				</button>
				{open ? (
					<LibrariesMenu
						id={menuId}
						label={shown.libraries}
						empty={shown.noLibraries}
						libraries={libraries}
						chosen={settings.libraryIds}
						button={button}
						onToggle={(id) =>
							onChange({
								...settings,
								libraryIds: settings.libraryIds.includes(id)
									? settings.libraryIds.filter((each) => each !== id)
									: // In the Site's order of Libraries, as they load.
										libraries
											.map((library) => library.id)
											.filter((each) => each === id || settings.libraryIds.includes(each)),
							})
						}
						onClose={(focusButton) => {
							setOpen(false);
							if (focusButton) button.current?.focus();
						}}
					/>
				) : null}
			</span>
		</fieldset>
	);
}

/**
 * The Site's Libraries as check items (`menuitemcheckbox`): Enter, Space or a click ticks one and the
 * menu stays open; the arrows, Home and End move; Escape goes back to the button; Tab leaves. A Site
 * without Libraries shows one item, disabled, saying where to add them.
 */
function LibrariesMenu({
	id,
	label,
	empty,
	libraries,
	chosen,
	button,
	onToggle,
	onClose,
}: {
	id: string;
	label: string;
	empty: string;
	libraries: readonly { id: string; name: string }[];
	chosen: readonly string[];
	button: RefObject<HTMLButtonElement | null>;
	onToggle(id: string): void;
	onClose(focusButton: boolean): void;
}) {
	const menu = useRef<HTMLDivElement>(null);
	const latest = useRef(onClose);
	latest.current = onClose;
	const items = () => [...(menu.current?.querySelectorAll<HTMLElement>("[role^='menuitem']") ?? [])];

	useEffect(() => {
		menu.current?.querySelector<HTMLElement>("[role^='menuitem']")?.focus();
		const outside = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && (menu.current?.contains(target) || button.current?.contains(target))) return;
			latest.current(false);
		};
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, [button]);

	const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const all = items();
		const at = all.indexOf(document.activeElement as HTMLElement);
		const move = (index: number) => all[(index + all.length) % all.length]?.focus();
		switch (event.key) {
			case "ArrowDown":
				move(at + 1);
				break;
			case "ArrowUp":
				move(at - 1);
				break;
			case "Home":
				move(0);
				break;
			case "End":
				move(all.length - 1);
				break;
			case "Escape":
				onClose(true);
				break;
			case "Tab":
				onClose(false);
				return;
			default:
				return;
		}
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<div
			ref={menu}
			id={id}
			role="menu"
			aria-label={label}
			tabIndex={-1}
			onKeyDown={onKey}
			className="border-chrome-hover bg-chrome-menu absolute start-0 top-[calc(100%+4px)] z-50 flex max-h-[min(320px,60vh)] w-64 flex-col gap-0.5 overflow-y-auto rounded-lg border p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
			data-wc-libraries-menu=""
		>
			{libraries.length === 0 ? (
				<div
					role="menuitem"
					aria-disabled="true"
					tabIndex={-1}
					className={`text-chrome-muted rounded-md px-2 py-1 text-[12px] ${FOCUS_RING}`}
				>
					{empty}
				</div>
			) : (
				libraries.map((library) => {
					const checked = chosen.includes(library.id);
					return (
						<button
							key={library.id}
							type="button"
							role="menuitemcheckbox"
							aria-checked={checked}
							tabIndex={-1}
							onClick={() => onToggle(library.id)}
							className={`text-chrome-text hover:bg-chrome-hover focus:bg-chrome-hover flex min-h-7 items-center gap-2 rounded-md px-2 py-1 text-start text-[12px] ${FOCUS_RING}`}
							data-wc-library={library.id}
						>
							<span
								aria-hidden="true"
								className={`grid size-3.5 shrink-0 place-items-center rounded-[3px] border ${
									checked ? "border-chrome-strong bg-chrome-strong text-chrome-menu" : "border-chrome-muted"
								}`}
							>
								{checked ? <CheckIcon className="size-3" /> : null}
							</span>
							<span className="min-w-0 grow truncate">{library.name}</span>
						</button>
					);
				})
			)}
		</div>
	);
}
