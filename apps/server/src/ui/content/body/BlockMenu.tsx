import { Input } from "@webcraft/ui/components/input.tsx";
import { BoxesIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { BodyComponentChoice } from "../../../body-editor/model.ts";

import { useT } from "../../i18n.tsx";
import { type BlockChoice, matches } from "./choices.ts";

/**
 * The Block chooser: what `/` opens in an empty paragraph, and the toolbar's Add block button. A box
 * to type in filters the Blocks the Body field allows (a combobox over a list box); the arrow keys move
 * through them, Enter chooses one, and Escape closes it (keeping the `/` typed, when it opened from one).
 */
export function BlockMenu({
	choices,
	components = [],
	onComponent,
	onChoose,
	onClose,
}: {
	choices: readonly BlockChoice[];
	components?: readonly BodyComponentChoice[];
	onComponent?(component: BodyComponentChoice): void;
	onChoose(choice: BlockChoice): void;
	onClose(): void;
}) {
	const t = useT();
	const id = useId();
	const input = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const shown = [
		...choices
			.filter((choice) => matches(choice, t(choice.label), query))
			.map((choice) => ({ id: choice.id, name: t(choice.label), icon: choice.icon, choose: () => onChoose(choice) })),
		...components
			.filter((component) => component.name.toLowerCase().includes(query.toLowerCase()))
			.map((component) => ({
				id: component.id,
				name: component.name,
				icon: BoxesIcon,
				choose: () => onComponent?.(component),
			})),
	].sort(
		(a, b) =>
			Number(b.name.toLowerCase().startsWith(query.toLowerCase())) -
			Number(a.name.toLowerCase().startsWith(query.toLowerCase())),
	);
	const current = shown[Math.min(active, shown.length - 1)];

	useEffect(() => {
		input.current?.focus();
	}, []);

	const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActive((before) =>
				shown.length === 0 ? 0 : (Math.min(before, shown.length - 1) + step + shown.length) % shown.length,
			);
		} else if (event.key === "Home" || event.key === "End") {
			event.preventDefault();
			setActive(event.key === "Home" ? 0 : Math.max(0, shown.length - 1));
		} else if (event.key === "Enter") {
			event.preventDefault();
			current?.choose();
		} else if (event.key === "Escape" || (event.key === "Backspace" && query === "")) {
			event.preventDefault();
			event.stopPropagation();
			onClose();
		} else if (event.key === "Tab") {
			onClose();
		}
	};

	return (
		<div className="bg-popover text-popover-foreground absolute inset-x-0 top-full z-20 mt-1 grid w-72 max-w-full gap-1 rounded-md border p-1 shadow-md">
			<Input
				ref={input}
				role="combobox"
				aria-label={t("body.menu.label")}
				aria-expanded="true"
				aria-controls={`${id}-list`}
				aria-autocomplete="list"
				aria-activedescendant={current ? `${id}-${current.id}` : undefined}
				placeholder={t("body.menu.placeholder")}
				value={query}
				autoComplete="off"
				onChange={(event) => {
					setQuery(event.target.value);
					setActive(0);
				}}
				onKeyDown={keyDown}
				onBlur={(event) => {
					if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) onClose();
				}}
			/>
			<div id={`${id}-list`} role="listbox" aria-label={t("body.menu.label")} className="grid max-h-72 overflow-y-auto">
				{shown.map((choice) => (
					<div
						key={choice.id}
						id={`${id}-${choice.id}`}
						role="option"
						tabIndex={-1}
						aria-selected={choice === current}
						className="aria-selected:bg-accent aria-selected:text-accent-foreground flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
						onMouseDown={(event) => event.preventDefault()}
						onMouseMove={() => setActive(shown.indexOf(choice))}
						onClick={() => choice.choose()}
						onKeyDown={() => {}}
					>
						<choice.icon className="text-muted-foreground size-4" aria-hidden="true" />
						{choice.name}
					</div>
				))}
			</div>
			<p className="text-muted-foreground px-2 py-1.5 text-sm empty:hidden" role="status">
				{shown.length === 0 ? t("body.menu.none") : ""}
			</p>
		</div>
	);
}
