import { CheckIcon, ChevronUpIcon, LanguagesIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";

/** One of the page's languages: the page in it, or that language's home page where it is hidden. */
export type PageLanguage = { code: string; name: string; path: string; current: boolean };

/**
 * The language of the page in the frame (SPEC 2, bottom bar): a filled select that opens upwards
 * (`builder/01`), listing the Site's languages; choosing one opens the page in it. A menu button
 * (`aria-haspopup`), its items radio items, with the keys menus have: arrows, Home, End, Escape.
 */
export function LanguageMenu({
	languages,
	words,
	onChoose,
	look = "bar",
}: {
	languages: readonly PageLanguage[];
	words: Words;
	onChoose(language: PageLanguage): void;
	/** The Staff's bar (28 high, the code), or client editing's (36 high, the language's name; BA-14). */
	look?: "bar" | "client";
}) {
	const [open, setOpen] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const id = useId();
	const current = languages.find((language) => language.current) ?? languages[0];

	const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];

	useEffect(() => {
		if (!open) return;
		// The chosen language first, as a select does.
		const all = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
		(all.find((item) => item.getAttribute("aria-checked") === "true") ?? all[0])?.focus();
		const outside = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && (menu.current?.contains(target) || button.current?.contains(target))) return;
			setOpen(false);
		};
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, [open]);

	if (!current) return null;

	const close = (focusButton: boolean) => {
		setOpen(false);
		if (focusButton) button.current?.focus();
	};

	const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
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
				close(true);
				break;
			case "Tab":
				close(false);
				return;
			default:
				return;
		}
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<div className="relative shrink-0">
			<button
				ref={button}
				type="button"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				// Named with the words it shows: the language's name for a client, its code first for Staff.
				aria-label={
					look === "client"
						? `${words.language}: ${current.name}`
						: fill(words.languageCode, { code: current.code.toUpperCase(), name: current.name })
				}
				onClick={() => setOpen((was) => !was)}
				onKeyDown={(event) => {
					if (event.key === "ArrowUp" || event.key === "ArrowDown") {
						event.preventDefault();
						setOpen(true);
					}
				}}
				className={`bg-chrome-raised text-chrome-text hover:bg-chrome-hover flex items-center font-medium ${
					look === "client" ? "h-9 gap-[7px] rounded-lg px-3 text-[13px]" : "h-7 gap-1.5 rounded-md px-2 text-[12px]"
				} ${CHROME_EASE} ${FOCUS_RING}`}
				data-wc-language=""
			>
				<LanguagesIcon
					aria-hidden="true"
					className={look === "client" ? "text-chrome-text size-4" : "text-chrome-muted size-3.5"}
				/>
				<span>{look === "client" ? current.name : current.code.toUpperCase()}</span>
				<ChevronUpIcon aria-hidden="true" className="text-chrome-muted size-3.5" />
			</button>
			{open ? (
				<div
					ref={menu}
					id={id}
					role="menu"
					aria-label={words.language}
					tabIndex={-1}
					onKeyDown={onMenuKey}
					className="border-chrome-hover bg-chrome-menu absolute end-0 bottom-[calc(100%+6px)] z-50 flex min-w-44 flex-col gap-0.5 rounded-lg border p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
				>
					{languages.map((language) => (
						<button
							key={language.code}
							type="button"
							role="menuitemradio"
							aria-checked={language.current}
							tabIndex={-1}
							onClick={() => {
								close(true);
								if (!language.current) onChoose(language);
							}}
							className={`text-chrome-text hover:bg-chrome-hover focus:bg-chrome-hover flex h-7 items-center gap-2 rounded-md px-2 text-start text-[12px] ${FOCUS_RING}`}
						>
							<span className="text-chrome-muted w-6 font-mono text-[11px]">{language.code.toUpperCase()}</span>
							<span className="grow">{language.name}</span>
							{language.current ? <CheckIcon aria-hidden="true" className="text-chrome-strong size-3.5" /> : null}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}
