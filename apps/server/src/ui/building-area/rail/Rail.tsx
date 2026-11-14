import {
	ComponentIcon,
	EllipsisIcon,
	EyeIcon,
	EyeOffIcon,
	FileTextIcon,
	ImageIcon,
	LayoutTemplateIcon,
	LogOutIcon,
	MoonIcon,
	PaletteIcon,
	RepeatIcon,
	SettingsIcon,
	SunIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { fill, type ShellConfig } from "../api.ts";
import { FOCUS_RING, type Icon, IconButton, IconLink, Tip } from "../controls.tsx";
import { type PlaceKey, placeEntry } from "../places/registry.ts";

/** The rail's places (SPEC 2), each unavailable until it is in the places' registry (`places/registry.ts`). */
const PLACES = [
	{ key: "content", icon: FileTextIcon },
	{ key: "templates", icon: LayoutTemplateIcon },
	{ key: "media", icon: ImageIcon },
	{ key: "styles", icon: PaletteIcon },
	{ key: "loops", icon: RepeatIcon },
	{ key: "components", icon: ComponentIcon },
] as const satisfies readonly { key: PlaceKey; icon: Icon }[];

/** A person's initials for the avatar: the first letters of their first and last names. */
export function initialsOf(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	const first = parts[0]?.[0] ?? "";
	const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
	return `${first}${last}`.toUpperCase() || "?";
}

/**
 * The rail (SPEC 2 and 4): 48 wide, full height above the bottom bar. The logo tile goes back to the
 * admin; then the six places and "more" (each unavailable until it exists); below, Dark preview, the
 * Panels menu, Hide interface, the Site's settings (a new tab), Exit, and the person's avatar.
 */
export function Rail({
	config,
	place,
	onPlace,
	darkPreview,
	onDarkPreview,
	hidden,
	onHidden,
	onExit,
	exiting,
	panelsMenu,
}: {
	config: ShellConfig;
	/** The place open over the canvas (its button is drawn as the open place; pressing it again leaves). */
	place?: PlaceKey | null;
	/** A place's button was pressed: opens it, or leaves it when it is the open one. */
	onPlace?(key: PlaceKey): void;
	/** Whether the page in the frame shows its dark values. */
	darkPreview: boolean;
	onDarkPreview(on: boolean): void;
	/** Whether the interface (every dock) is hidden. */
	hidden: boolean;
	onHidden(hidden: boolean): void;
	onExit(): void;
	exiting: boolean;
	/** The Panels menu's button and its menu (the docks', BA-05). */
	panelsMenu: ReactNode;
}) {
	const { words } = config;
	return (
		<nav
			aria-label={words.rail}
			data-building-region="rail"
			className="border-chrome-line bg-chrome focus-visible:ring-chrome-focus col-start-1 row-start-1 flex min-h-0 w-12 flex-col items-center border-e outline-none focus-visible:ring-2 focus-visible:ring-inset"
		>
			<div className="flex h-11 w-12 shrink-0 items-center justify-center">
				<a
					href={config.returnTo}
					aria-label={words.backToAdmin}
					className={`group bg-chrome-strong relative grid size-7 place-items-center rounded-[7px] text-[14px] font-bold text-[#18181b] ${FOCUS_RING}`}
					data-wc-logo=""
				>
					<span aria-hidden="true">W</span>
					<Tip label={words.backToAdmin} side="end" />
				</a>
			</div>
			<ul className="flex flex-col items-center gap-2 pt-1" data-wc-places="">
				{PLACES.map((each) => {
					const available = placeEntry(each.key) !== null;
					return (
						<li key={each.key} className="flex">
							<IconButton
								icon={each.icon}
								label={words.places[each.key]}
								unavailable={available ? undefined : words.unavailable}
								pressed={available ? place === each.key : undefined}
								on={place === each.key}
								onClick={() => onPlace?.(each.key)}
								side="end"
								data={{ "data-wc-place": each.key }}
							/>
						</li>
					);
				})}
				<li className="flex">
					<IconButton
						icon={EllipsisIcon}
						label={words.places.more}
						unavailable={words.unavailable}
						side="end"
						className="text-chrome-muted"
						data={{ "data-wc-place": "more" }}
					/>
				</li>
			</ul>
			<div className="min-h-2 grow" />
			<div className="flex flex-col items-center gap-2 pb-2.5" data-wc-utilities="">
				<IconButton
					icon={darkPreview ? SunIcon : MoonIcon}
					label={words.darkPreview}
					side="end"
					pressed={config.darkMode ? darkPreview : undefined}
					on={darkPreview}
					unavailable={config.darkMode ? undefined : words.noDarkMode}
					onClick={() => onDarkPreview(!darkPreview)}
					data={{ "data-wc-rail": "dark-preview" }}
				/>
				{/* The Panels menu and Hide interface are the canvas's: a place has neither (`places-content/01`). */}
				{place ? null : (
					<>
						{panelsMenu}
						<IconButton
							icon={hidden ? EyeOffIcon : EyeIcon}
							label={hidden ? words.showInterface : words.hideInterface}
							side="end"
							on={hidden}
							onClick={() => onHidden(!hidden)}
							data={{ "data-wc-rail": "hide-interface" }}
						/>
					</>
				)}
				<IconLink
					icon={SettingsIcon}
					label={words.settings}
					side="end"
					href={config.settings}
					newTab
					data={{ "data-wc-rail": "settings" }}
				/>
				<IconButton
					icon={LogOutIcon}
					label={words.exit}
					side="end"
					disabled={exiting}
					onClick={onExit}
					data={{ "data-wc-rail": "exit" }}
				/>
				<span
					role="img"
					aria-label={fill(words.signedInAs, { name: config.person.name })}
					className="text-chrome-strong grid size-7 place-items-center rounded-full bg-[#52525b] text-[10px] font-semibold"
					data-wc-avatar=""
				>
					<span aria-hidden="true">{initialsOf(config.person.name)}</span>
				</span>
			</div>
		</nav>
	);
}
