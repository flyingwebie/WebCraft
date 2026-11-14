import { FileTextIcon, ImageIcon, LifeBuoyIcon, LogOutIcon, PanelsTopLeftIcon } from "lucide-react";

import { fill, type ShellConfig } from "../api.ts";
import { CHROME_EASE, FOCUS_RING, type Icon } from "../controls.tsx";
import { initialsOf } from "../rail/Rail.tsx";

/** The places a Member opens from the rail (SPEC 13.1 and 13.6): Content and Media, no other. */
export const CLIENT_PLACES = ["content", "media"] as const;
export type ClientPlace = (typeof CLIENT_PLACES)[number];

/** A Site's initials for its tile: the first letters of its first two words. */
function siteInitials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	return (
		parts
			.slice(0, 2)
			.map((part) => part[0] ?? "")
			.join("")
			.toUpperCase() || "?"
	);
}

/** One item of the rail: an icon (20) over a word (11 px), 62 × 54 (`client/01`). */
function RailItem({
	icon: Glyph,
	label,
	on,
	pressed,
	onClick,
	disabled,
	data,
}: {
	icon: Icon;
	label: string;
	on?: boolean;
	pressed?: boolean;
	onClick(): void;
	disabled?: boolean;
	data: Record<`data-${string}`, string>;
}) {
	return (
		<button
			type="button"
			aria-pressed={pressed}
			disabled={disabled}
			onClick={onClick}
			className={`flex h-[54px] w-[62px] shrink-0 flex-col items-center justify-center gap-1 rounded-[10px] ${
				on ? "text-chrome-strong bg-[#3f3f46]" : "text-chrome-text hover:bg-chrome-hover hover:text-chrome-strong"
			} disabled:opacity-35 ${CHROME_EASE} ${FOCUS_RING}`}
			{...data}
		>
			<Glyph aria-hidden="true" className="size-5" />
			<span className={`text-[11px] leading-[14px] ${on ? "font-semibold" : "text-chrome-muted font-medium"}`}>
				{label}
			</span>
		</button>
	);
}

/**
 * The rail drawn for a client (SPEC 13.1, `client/01`): 76 wide, each item an icon over a word. The
 * Site's tile at the top goes back to the dashboard, as Exit does; then Page (the canvas), Content and
 * Media; at the foot Help, Exit and the person's avatar. Nothing else of the Staff's rail is here.
 */
export function ClientRail({
	config,
	place,
	onPage,
	onPlace,
	helpOpen,
	onHelp,
	onExit,
	exiting,
}: {
	config: ShellConfig;
	/** The place open over the canvas, if any: its item is the one drawn as on. */
	place: ClientPlace | null;
	/** Page: back to the canvas from a place. */
	onPage(): void;
	onPlace(place: ClientPlace): void;
	helpOpen: boolean;
	onHelp(): void;
	onExit(): void;
	exiting: boolean;
}) {
	const { words } = config;
	const said = words.client;
	return (
		<nav
			aria-label={said.rail}
			data-building-region="rail"
			className="border-chrome-line bg-chrome focus-visible:ring-chrome-focus col-start-1 row-start-1 flex min-h-0 w-[76px] flex-col items-center gap-1.5 border-e py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset"
			data-wc-client-rail=""
		>
			<a
				href={config.returnTo}
				title={fill(said.site, { site: config.site.name })}
				className={`bg-primary text-primary-foreground grid size-10 shrink-0 place-items-center rounded-[10px] text-[14px] font-bold ${FOCUS_RING}`}
				data-wc-logo=""
			>
				<span aria-hidden="true">{siteInitials(config.site.name)}</span>
				<span className="sr-only">{fill(said.site, { site: config.site.name })}</span>
			</a>
			<div className="h-1 shrink-0" />
			<RailItem
				icon={PanelsTopLeftIcon}
				label={said.page}
				on={place === null}
				pressed={place === null}
				onClick={onPage}
				data={{ "data-wc-place": "page" }}
			/>
			<RailItem
				icon={FileTextIcon}
				label={words.places.content}
				on={place === "content"}
				pressed={place === "content"}
				onClick={() => onPlace("content")}
				data={{ "data-wc-place": "content" }}
			/>
			<RailItem
				icon={ImageIcon}
				label={words.places.media}
				on={place === "media"}
				pressed={place === "media"}
				onClick={() => onPlace("media")}
				data={{ "data-wc-place": "media" }}
			/>
			<div className="min-h-2 grow" />
			<RailItem
				icon={LifeBuoyIcon}
				label={said.help}
				on={helpOpen}
				pressed={helpOpen}
				onClick={onHelp}
				data={{ "data-wc-rail": "help" }}
			/>
			<RailItem
				icon={LogOutIcon}
				label={said.exit}
				onClick={onExit}
				disabled={exiting}
				data={{ "data-wc-rail": "exit" }}
			/>
			<div className="h-0.5 shrink-0" />
			<span
				role="img"
				aria-label={fill(words.signedInAs, { name: config.person.name })}
				className="text-chrome-strong grid size-8 shrink-0 place-items-center rounded-full bg-[#52525b] text-[11px] font-semibold"
				data-wc-avatar=""
			>
				<span aria-hidden="true">{initialsOf(config.person.name)}</span>
			</span>
		</nav>
	);
}
