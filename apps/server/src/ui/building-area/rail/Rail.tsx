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
	ScanEyeIcon,
	SettingsIcon,
	SunIcon,
} from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";

import { type ClientRole, fill, type ShellConfig } from "../api.ts";
import { ChoiceMenu } from "../ChoiceMenu.tsx";
import { FOCUS_RING, type Icon, IconButton, IconLink, Tip } from "../controls.tsx";
import { morePlaces, type PlaceKey, placeEntry } from "../places/registry.ts";

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
 * admin; then the six places and "more" (each unavailable until it exists); below, Dark preview, View
 * as a client (FX-04), the Panels menu, Hide interface, the Site's settings (a new tab), Exit, and the
 * person's avatar.
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
	onViewAsClient,
	switching = false,
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
	/** "View as a client" (FX-04): the page as a Member of the role chosen sees it. */
	onViewAsClient?(role: ClientRole): void;
	/** Whether the tab is going over to client editing. */
	switching?: boolean;
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
					<MorePlaces config={config} place={place ?? null} onPlace={onPlace} />
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
				{onViewAsClient && config.clientRoles.length > 0 ? (
					<ViewAsClient config={config} onChoose={onViewAsClient} switching={switching} />
				) : null}
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

/**
 * "View as a client" (FX-04): the page as a Member sees it in client editing. The roles that change
 * different things are offered in a menu (an Owner or Editor publishes, an Author sends for review);
 * with one, the button switches at once.
 */
function ViewAsClient({
	config,
	onChoose,
	switching,
}: {
	config: ShellConfig;
	onChoose(role: ClientRole): void;
	switching: boolean;
}) {
	const { words } = config;
	const said = words.viewAs;
	const [open, setOpen] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	const id = useId();
	const roles = config.clientRoles;
	const only = roles.length === 1 ? roles[0] : undefined;
	return (
		<span className="relative flex">
			<IconButton
				ref={button}
				icon={ScanEyeIcon}
				label={said.button}
				side="end"
				disabled={switching}
				popup={only ? undefined : { open, id }}
				onClick={() => (only ? onChoose(only) : setOpen((was) => !was))}
				data={{ "data-wc-rail": "view-as-client" }}
			/>
			{open ? (
				<ChoiceMenu
					id={id}
					label={said.menu}
					groups={[
						{
							label: null,
							choices: roles.map((role) => ({
								key: role.key,
								label: said.roles[role.key],
								detail: said.details[role.key],
							})),
						},
					]}
					button={button}
					side="end"
					onChoose={(choice) => {
						const role = roles.find((each) => each.key === choice.key);
						if (role) onChoose(role);
					}}
					onClose={(focusButton) => {
						setOpen(false);
						if (focusButton) button.current?.focus();
					}}
				/>
			) : null}
		</span>
	);
}

/**
 * "more" (SPEC 2): the places Modules add, behind one button: a menu of them (Forms, SPEC 15.2),
 * drawn as the open place while one of them is open. Unavailable while none exists.
 */
function MorePlaces({
	config,
	place,
	onPlace,
}: {
	config: ShellConfig;
	place: PlaceKey | null;
	onPlace?(key: PlaceKey): void;
}) {
	const { words } = config;
	const [open, setOpen] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	const id = useId();
	const places = morePlaces();
	const inOne = places.some((each) => each.key === place);
	if (places.length === 0) {
		return (
			<IconButton
				icon={EllipsisIcon}
				label={words.places.more}
				unavailable={words.unavailable}
				side="end"
				className="text-chrome-muted"
				data={{ "data-wc-place": "more" }}
			/>
		);
	}
	return (
		<span className="relative flex">
			<IconButton
				ref={button}
				icon={EllipsisIcon}
				label={words.places.more}
				side="end"
				on={inOne}
				popup={{ open, id }}
				onClick={() => setOpen((was) => !was)}
				className={inOne ? undefined : "text-chrome-muted"}
				data={{ "data-wc-place": "more" }}
			/>
			{open ? (
				<ChoiceMenu
					id={id}
					label={words.places.more}
					groups={[
						{
							label: null,
							choices: places.map((each) => ({
								key: each.key,
								label: words.places[each.key],
								current: each.key === place,
							})),
						},
					]}
					button={button}
					side="end"
					onChoose={(choice) => onPlace?.(choice.key as PlaceKey)}
					onClose={(focusButton) => {
						setOpen(false);
						if (focusButton) button.current?.focus();
					}}
				/>
			) : null}
		</span>
	);
}
