import { useNavigate } from "@tanstack/react-router";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@webcraft/ui/components/dialog.tsx";
import { useSidebar } from "@webcraft/ui/components/sidebar.tsx";
import { Building2Icon, GlobeIcon, type LucideIcon, SearchIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import { useT } from "../i18n.tsx";
import type { ShellContext } from "./context.ts";
import type { AdminPlace, NavRow, NavTarget } from "./levels.ts";
import { useNavigation, useRowLabel } from "./navigation.tsx";

/** One thing Search can go to: a screen of the level, a Workspace, or a Site of the Workspace. */
type Destination = NavTarget & { id: string; name: string; within?: string; icon: LucideIcon };

/**
 * Search, under the context switcher: a box that opens a dialog (also with ⌘K or Ctrl K anywhere in
 * the admin) to go to any screen of the level, including those inside a secondary sidebar, a
 * Workspace the person reaches, or a Site of the Workspace they are in. Arrow keys move, Enter
 * opens, Escape closes.
 */
export function AdminSearch({ shell, place }: { shell: ShellContext; place: AdminPlace }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const { isMobile, setOpenMobile } = useSidebar();

	useEffect(() => {
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey) {
				event.preventDefault();
				setOpen(true);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const apple = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				aria-haspopup="dialog"
				aria-keyshortcuts="Meta+K Control+K"
				className="border-input bg-background text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 flex h-9 w-full items-center gap-2 rounded-md border px-2.5 text-start text-sm shadow-xs transition-colors outline-none focus-visible:ring-3"
			>
				<SearchIcon className="size-4 shrink-0" aria-hidden="true" />
				<span className="min-w-0 flex-1 truncate">{t("shell.search.label")}</span>
				<kbd className="bg-muted text-muted-foreground inline-flex h-5 min-w-5 items-center justify-center rounded border px-1 font-sans text-[11px] font-medium">
					{apple ? "⌘K" : "Ctrl K"}
				</kbd>
			</button>
			{open ? (
				<SearchDialog
					shell={shell}
					place={place}
					onClose={() => setOpen(false)}
					onGo={() => {
						setOpen(false);
						if (isMobile) setOpenMobile(false);
					}}
				/>
			) : null}
		</>
	);
}

function SearchDialog({
	shell,
	place,
	onClose,
	onGo,
}: {
	shell: ShellContext;
	place: AdminPlace;
	onClose: () => void;
	onGo: () => void;
}) {
	const t = useT();
	const label = useRowLabel();
	const navigate = useNavigate();
	const navigation = useNavigation();
	const id = useId();
	const input = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);

	const destinations = useMemo(() => {
		const found: Destination[] = [];
		const add = (row: NavRow, parent: NavRow | null) => {
			if (row.sections) {
				for (const section of row.sections) for (const child of section.rows) add(child, row);
				return;
			}
			found.push({
				id: `screen-${row.id}`,
				to: row.to,
				params: row.params,
				name: label(row.label),
				within: parent ? label(parent.label) : undefined,
				icon: row.icon,
			});
		};
		for (const group of navigation.groups) for (const row of group.rows) add(row, null);
		for (const row of navigation.footer) add(row, null);
		for (const row of navigation.aside) add(row, null);
		for (const workspace of shell.workspaces)
			found.push({
				id: `workspace-${workspace.id}`,
				to: "/workspaces/$workspaceId",
				params: { workspaceId: workspace.id },
				name: workspace.name,
				within: t("shell.switcher.workspaces"),
				icon: Building2Icon,
			});
		if (place.level !== "install")
			for (const site of place.sites)
				found.push({
					id: `site-${site.id}`,
					to: "/sites/$siteId",
					params: { siteId: site.id },
					name: site.name,
					within: place.workspace.name,
					icon: GlobeIcon,
				});
		return found;
	}, [navigation, shell.workspaces, place, label, t]);

	const words = query.trim().toLocaleLowerCase();
	const results = words
		? destinations.filter((destination) =>
				`${destination.within ?? ""} ${destination.name}`.toLocaleLowerCase().includes(words),
			)
		: destinations;
	const current = Math.min(active, Math.max(0, results.length - 1));

	const go = (destination: Destination | undefined) => {
		if (!destination) return;
		onGo();
		void navigate({ to: destination.to, params: destination.params as never });
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setActive((current + 1) % Math.max(1, results.length));
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setActive((current - 1 + results.length) % Math.max(1, results.length));
		} else if (event.key === "Enter") {
			event.preventDefault();
			go(results[current]);
		}
	};

	// The active result stays in view as the arrow keys move it.
	useEffect(() => {
		document.getElementById(`${id}-option-${current}`)?.scrollIntoView({ block: "nearest" });
	}, [id, current]);

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent
				closeLabel={t("shell.search.close")}
				initialFocus={input}
				showCloseButton={false}
				className="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg"
			>
				<DialogTitle className="sr-only">{t("shell.search.title")}</DialogTitle>
				<DialogDescription className="sr-only">{t("shell.search.description")}</DialogDescription>
				<div className="flex items-center gap-2 border-b px-3">
					<SearchIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
					<input
						ref={input}
						role="combobox"
						aria-expanded="true"
						aria-controls={`${id}-list`}
						aria-activedescendant={results.length > 0 ? `${id}-option-${current}` : undefined}
						aria-autocomplete="list"
						aria-label={t("shell.search.title")}
						aria-describedby={`${id}-keys`}
						placeholder={t("shell.search.placeholder")}
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setActive(0);
						}}
						onKeyDown={onKeyDown}
						className="placeholder:text-muted-foreground h-12 min-w-0 flex-1 bg-transparent text-sm outline-none"
					/>
				</div>
				<div
					id={`${id}-list`}
					role="listbox"
					aria-label={t("shell.search.results")}
					className="max-h-[min(24rem,60svh)] overflow-y-auto p-2"
				>
					{results.map((destination, index) => (
						// The input keeps focus and names the active option; a click or tap opens one too.
						<div
							key={destination.id}
							id={`${id}-option-${index}`}
							role="option"
							tabIndex={-1}
							aria-selected={index === current}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => go(destination)}
							onKeyDown={() => {}}
							onPointerMove={() => setActive(index)}
							className="aria-selected:bg-accent aria-selected:text-accent-foreground flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-sm"
						>
							<destination.icon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
							<span className="min-w-0 flex-1 truncate">
								{destination.within ? <span className="text-muted-foreground">{destination.within} › </span> : null}
								{destination.name}
							</span>
						</div>
					))}
				</div>
				{results.length === 0 ? (
					<p role="status" className="text-muted-foreground px-4 pb-4 text-sm">
						{t("shell.search.none", { query: query.trim() })}
					</p>
				) : null}
				<p id={`${id}-keys`} className="text-muted-foreground border-t px-4 py-2 text-xs">
					{t("shell.search.keys")}
				</p>
			</DialogContent>
		</Dialog>
	);
}
