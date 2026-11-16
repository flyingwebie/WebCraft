import { PanelsTopLeftIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useId, useRef, useState } from "react";

import { IconButton } from "../controls.tsx";
import { type Docks, panelName } from "./Docks.tsx";
import { placeOf } from "./layout.ts";
import { ChromeMenu, type MenuEntry } from "./Menu.tsx";
import { PANELS } from "./panels.ts";

/**
 * The Panels menu on the rail (`docking/03`): one switch per panel, and "Reset panel layout". A panel
 * shows when its switch is on and its own rule holds; switching one off hides it where it is, and
 * nothing else in the layout moves.
 */
export function PanelsMenu({ docks }: { docks: Docks }) {
	const { words, layout } = docks;
	const [open, setOpen] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	const id = useId();
	const close = useCallback((focusButton: boolean) => {
		setOpen(false);
		if (focusButton) button.current?.focus();
	}, []);

	const entries: MenuEntry[] = [
		...PANELS.map(
			(panel): MenuEntry => ({
				kind: "switch",
				key: panel.id,
				label: panelName(words, panel.id),
				checked: !placeOf(layout, panel.id)?.panel.hidden,
				onToggle: () => docks.toggle(panel.id),
			}),
		),
		{ kind: "separator", key: "line" },
		{
			kind: "item",
			key: "reset",
			icon: RotateCcwIcon,
			label: words.docks.reset,
			onSelect: () => {
				docks.reset();
				button.current?.focus();
			},
		},
	];

	return (
		<>
			<IconButton
				ref={button}
				icon={PanelsTopLeftIcon}
				label={words.panels}
				side="end"
				on={open}
				popup={{ open, id }}
				onClick={() => setOpen((was) => !was)}
				data={{ "data-wc-rail": "panels" }}
			/>
			<ChromeMenu
				open={open}
				onClose={close}
				anchor={button}
				placement="beside"
				label={words.panels}
				entries={entries}
				width={224}
				id={id}
			/>
		</>
	);
}
