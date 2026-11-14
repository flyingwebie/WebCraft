import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { type ComponentProps, Fragment, type ReactNode, useId } from "react";

import type { NavRow } from "./levels.ts";
import { CountBadge, type Current, RowBadge, RowLink, useRowLabel } from "./navigation.tsx";

/**
 * The secondary sidebar: the sub-options of one sidebar row, inside the page card, 224 wide with
 * its own right border and the card's full height. It is a navigation landmark named by its title.
 * Put a `SecondaryTitle` first, then `SecondaryLabel`s and `SecondaryList`s of `SecondaryLink`s.
 * On a phone there is no room for it beside the page: a screen shows `SecondaryMenu` there instead.
 */
export function SecondarySidebar({
	labelledBy,
	className,
	...props
}: ComponentProps<"nav"> & { /** The id of its `SecondaryTitle`. */ labelledBy: string }) {
	return (
		<nav
			aria-labelledby={labelledBy}
			data-slot="secondary-sidebar"
			className={cn(
				"bg-background hidden w-56 shrink-0 flex-col gap-1 overflow-y-auto border-e p-3 md:flex",
				className,
			)}
			{...props}
		/>
	);
}

/** The secondary sidebar's title (the row that opened it), with room for a note at its end ("Staff only"). */
export function SecondaryTitle({ id, children, note }: { id: string; children: ReactNode; note?: ReactNode }) {
	return (
		<div className="flex h-9 shrink-0 items-center justify-between gap-2 px-2">
			<p id={id} className="truncate text-sm font-semibold">
				{children}
			</p>
			{note}
		</div>
	);
}

/** The label above a group of rows ("General", "Search and privacy"). */
export function SecondaryLabel({ className, ...props }: ComponentProps<"p">) {
	return (
		<p
			className={cn("text-muted-foreground flex h-8 shrink-0 items-end px-2 pb-1.5 text-xs font-medium", className)}
			{...props}
		/>
	);
}

/** A list of rows; `aria-labelledby` its `SecondaryLabel` when it has one. */
export function SecondaryList({ className, ...props }: ComponentProps<"ul">) {
	return <ul className={cn("flex flex-col gap-1", className)} {...props} />;
}

/** The look of one row of the secondary sidebar, for a link or a button drawn as one. */
export const secondaryRowClass =
	"text-muted-foreground hover:bg-accent focus-visible:ring-ring/50 aria-[current]:bg-accent aria-[current]:text-foreground flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-start text-sm outline-none transition-colors focus-visible:ring-3 aria-[current]:font-medium [&_svg]:size-4 [&_svg]:shrink-0";

/** One row of the navigation in the secondary sidebar: its icon, its name, and a count when it has one. */
function SecondaryRow({ row, current }: { row: NavRow; current: Current }) {
	const label = useRowLabel();
	return (
		<li>
			<RowLink row={row} current={current} className={secondaryRowClass}>
				<row.icon aria-hidden="true" />
				<span className="min-w-0 flex-1 truncate">{label(row.label)}</span>
				{row.badge ? <RowBadge badge={row.badge} /> : null}
				{row.count !== undefined && row.count > 0 ? <CountBadge count={row.count} /> : null}
			</RowLink>
		</li>
	);
}

/** The secondary sidebar of a sidebar row: its sections of rows, with the current one marked. */
export function NavigationSecondary({ parent, current }: { parent: NavRow; current: NavRow | null }) {
	const label = useRowLabel();
	const id = useId();
	return (
		<SecondarySidebar labelledBy={`${id}-title`}>
			<SecondaryTitle id={`${id}-title`} note={parent.badge ? <RowBadge badge={parent.badge} /> : null}>
				{label(parent.label)}
			</SecondaryTitle>
			{(parent.sections ?? []).map((section) => (
				<Fragment key={section.id}>
					{section.label ? <SecondaryLabel id={`${id}-${section.id}`}>{label(section.label)}</SecondaryLabel> : null}
					<SecondaryList aria-labelledby={section.label ? `${id}-${section.id}` : `${id}-title`}>
						{section.rows.map((row) => (
							<SecondaryRow key={row.id} row={row} current={row.id === current?.id ? "page" : undefined} />
						))}
					</SecondaryList>
				</Fragment>
			))}
		</SecondarySidebar>
	);
}

/**
 * The same rows on a phone, where the secondary sidebar has no room beside the page: one control
 * above the page that names the current row and opens the others as a menu.
 */
export function NavigationSecondaryMenu({ parent, current }: { parent: NavRow; current: NavRow | null }) {
	const label = useRowLabel();
	const title = label(parent.label);
	return (
		<div className="bg-background shrink-0 border-b px-4 py-2 md:hidden" data-slot="secondary-menu">
			<DropdownMenu>
				<DropdownMenuTrigger
					className="border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 flex h-9 w-full items-center gap-2 rounded-md border px-2.5 text-start text-sm shadow-xs outline-none focus-visible:ring-3"
					aria-label={current ? `${title}: ${label(current.label)}` : title}
				>
					<span className="text-muted-foreground shrink-0">{title}</span>
					<span className="min-w-0 flex-1 truncate font-medium">{current ? label(current.label) : null}</span>
					<ChevronsUpDownIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="max-h-[70svh]">
					{(parent.sections ?? []).map((section, index) => (
						<Fragment key={section.id}>
							{index > 0 ? <DropdownMenuSeparator /> : null}
							<DropdownMenuGroup>
								{section.label ? <DropdownMenuLabel>{label(section.label)}</DropdownMenuLabel> : null}
								{section.rows.map((row) => (
									<DropdownMenuItem
										key={row.id}
										render={<RowLink row={row} current={row.id === current?.id ? "page" : undefined} />}
									>
										<row.icon aria-hidden="true" />
										<span className="min-w-0 flex-1 truncate">{label(row.label)}</span>
										{row.count !== undefined && row.count > 0 ? <CountBadge count={row.count} /> : null}
										{row.id === current?.id ? <CheckIcon aria-hidden="true" /> : null}
									</DropdownMenuItem>
								))}
							</DropdownMenuGroup>
						</Fragment>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
