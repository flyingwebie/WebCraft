import { Avatar, AvatarFallback } from "@webcraft/ui/components/avatar.tsx";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@webcraft/ui/components/popover.tsx";
import { SidebarMenuButton, useSidebar } from "@webcraft/ui/components/sidebar.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import {
	ArrowRightIcon,
	CheckIcon,
	ChevronsUpDownIcon,
	PlusIcon,
	SearchIcon,
	SettingsIcon,
	ShieldIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";

import { getApi } from "../api.ts";
import { useT } from "../i18n.tsx";
import { initials, roleLabel, type ShellContext } from "./context.ts";
import type { AdminPlace, PlaceSite } from "./levels.ts";
import { RowLink } from "./navigation.tsx";

/** The Sites of a Workspace as the switcher has them: still loading, loaded, or failed to load. */
type SitesOf = { state: "loading" } | { state: "loaded"; sites: readonly PlaceSite[] } | { state: "failed" };

/**
 * The context switcher at the top of the sidebar: says where the person is (the Install, a Workspace
 * or a Site) and opens a popover in two columns. On the left the Workspaces they reach, with a box to
 * find one and "New Workspace"; on the right the Sites of the Workspace under the pointer or the
 * focus (the one they are in at first), "New Site" and "Workspace settings". Above both, the Install
 * with a link to its area. Choosing anything goes there and closes the popover.
 */
export function ContextSwitcher({ shell, place }: { shell: ShellContext; place: AdminPlace }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const { isMobile, setOpenMobile } = useSidebar();
	const installName = shell.install.name ?? t("app.name");
	const role = t(roleLabel(shell.person?.installRole ?? null));
	const { title, subtitle } =
		place.level === "install"
			? { title: installName, subtitle: t("shell.switcher.installSubtitle", { role }) }
			: place.level === "workspace"
				? {
						title: place.workspace.name,
						subtitle: t("shell.switcher.workspaceSubtitle", { count: place.sites.length }),
					}
				: { title: place.site.name, subtitle: place.site.slug };

	// A choice goes there and closes the popover (and the sidebar's sheet on a phone).
	const chosen = () => {
		setOpen(false);
		if (isMobile) setOpenMobile(false);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" />}>
				<Avatar className="size-8 rounded-lg">
					<AvatarFallback className="bg-primary text-primary-foreground rounded-lg text-[13px] font-semibold">
						{initials(title)}
					</AvatarFallback>
				</Avatar>
				<span className="grid flex-1 text-start leading-tight">
					<span className="truncate font-semibold">{title}</span>
					<span className="text-muted-foreground truncate text-xs">{subtitle}</span>
				</span>
				{/* Its name starts with what it shows, then says what it does. */}
				<span className="sr-only">{t("shell.switcher.label")}</span>
				<ChevronsUpDownIcon className="ms-auto size-4" aria-hidden="true" />
			</PopoverTrigger>
			<PopoverContent
				align="start"
				alignOffset={-8}
				sideOffset={0}
				className="w-[min(35rem,calc(100vw-1rem))] rounded-xl"
				aria-label={t("shell.switcher.title")}
			>
				{open ? <SwitcherBody shell={shell} place={place} installName={installName} onChosen={chosen} /> : null}
			</PopoverContent>
		</Popover>
	);
}

function SwitcherBody({
	shell,
	place,
	installName,
	onChosen,
}: {
	shell: ShellContext;
	place: AdminPlace;
	installName: string;
	onChosen: () => void;
}) {
	const t = useT();
	const id = useId();
	const here = place.level === "install" ? null : place.workspace.id;
	const [query, setQuery] = useState("");
	const [shown, setShown] = useState<string | null>(here ?? shell.workspaces[0]?.id ?? null);
	const [sitesOf, setSitesOf] = useState<Record<string, SitesOf>>(() =>
		place.level === "install" ? {} : { [place.workspace.id]: { state: "loaded", sites: place.sites } },
	);

	// The Sites of the Workspace on the right, loaded the first time it is shown.
	useEffect(() => {
		if (!shown || sitesOf[shown]) return;
		setSitesOf((known) => ({ ...known, [shown]: { state: "loading" } }));
		void (async () => {
			try {
				const api = await getApi();
				const { sites } = await api.sites.list({ workspaceId: shown });
				const listed = sites.map(({ id, name, slug }) => ({ id, name, slug }));
				setSitesOf((known) => ({ ...known, [shown]: { state: "loaded", sites: listed } }));
			} catch {
				setSitesOf((known) => ({ ...known, [shown]: { state: "failed" } }));
			}
		})();
	}, [shown, sitesOf]);

	const words = query.trim().toLocaleLowerCase();
	const workspaces = words
		? shell.workspaces.filter((workspace) => workspace.name.toLocaleLowerCase().includes(words))
		: shell.workspaces;
	const shownWorkspace = shell.workspaces.find((workspace) => workspace.id === shown) ?? null;
	const sites = shown ? sitesOf[shown] : undefined;
	const currentSite = place.level === "site" ? place.site.id : null;
	const staff = Boolean(shell.person?.installRole);

	return (
		<div className="text-sm">
			<div className="flex h-11 items-center justify-between gap-3 border-b px-3">
				<div className="flex min-w-0 items-center gap-2">
					<ShieldIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
					<span className="truncate text-[13px] font-semibold">{installName}</span>
					<Badge variant="outline">{t("shell.switcher.install")}</Badge>
				</div>
				<RowLink
					row={{ to: "/", params: {} }}
					onClick={onChosen}
					current={place.level === "install" ? "true" : undefined}
					className="text-primary focus-visible:ring-ring/50 inline-flex shrink-0 items-center gap-1 rounded-sm text-[13px] font-medium outline-none hover:underline focus-visible:ring-3"
				>
					{t("shell.switcher.installArea")}
					<ArrowRightIcon className="size-3.5 rtl:rotate-180" aria-hidden="true" />
				</RowLink>
			</div>
			<div className="flex flex-col sm:flex-row sm:items-start">
				<div className="flex flex-col gap-1 border-b p-2 sm:w-1/2 sm:border-e sm:border-b-0">
					<div className="relative">
						<SearchIcon
							className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2"
							aria-hidden="true"
						/>
						<input
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={t("shell.switcher.findWorkspace")}
							aria-label={t("shell.switcher.findWorkspace")}
							aria-controls={`${id}-workspaces`}
							className="border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 h-9 w-full rounded-md border bg-transparent ps-8 pe-2.5 text-sm shadow-xs outline-none focus-visible:ring-3"
						/>
					</div>
					<p
						id={`${id}-workspaces-label`}
						className="text-muted-foreground flex h-7 items-center px-2 text-xs font-medium"
					>
						{t("shell.switcher.workspaces")}
					</p>
					<ul id={`${id}-workspaces`} aria-labelledby={`${id}-workspaces-label`} className="flex flex-col gap-1">
						{workspaces.map((workspace) => {
							const current = workspace.id === here;
							return (
								<li key={workspace.id}>
									<RowLink
										row={{ to: "/workspaces/$workspaceId", params: { workspaceId: workspace.id } }}
										onClick={onChosen}
										onPointerEnter={() => setShown(workspace.id)}
										onFocus={() => setShown(workspace.id)}
										current={current ? "true" : undefined}
										className={cn(switcherRow, "h-10", workspace.id === shown && "bg-accent text-accent-foreground")}
									>
										<span
											aria-hidden="true"
											className={cn(
												"flex size-7 shrink-0 items-center justify-center rounded-[7px] text-xs font-semibold",
												current ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
											)}
										>
											{initials(workspace.name)}
										</span>
										<span className={cn("min-w-0 flex-1 truncate", current && "font-medium")}>{workspace.name}</span>
										{current ? <CheckIcon className="size-4 shrink-0" aria-hidden="true" /> : null}
									</RowLink>
								</li>
							);
						})}
					</ul>
					{workspaces.length === 0 ? (
						<p role="status" className="text-muted-foreground px-2 py-2 text-sm">
							{t("shell.switcher.noWorkspaces")}
						</p>
					) : null}
					{shell.permissions.includes("workspace.create") ? (
						<>
							<hr className="my-1 border-t" />
							<SwitcherLink to="/workspaces" icon={<PlusIcon aria-hidden="true" />} onChosen={onChosen}>
								{t("shell.switcher.newWorkspace")}
							</SwitcherLink>
						</>
					) : null}
				</div>
				{shownWorkspace ? (
					<div className="flex flex-col gap-1 p-2 sm:w-1/2">
						<p
							id={`${id}-sites-label`}
							className="text-muted-foreground flex h-7 items-center px-2 text-xs font-medium"
						>
							{t("shell.switcher.sitesIn", { workspace: shownWorkspace.name })}
						</p>
						{sites?.state === "loaded" ? (
							sites.sites.length > 0 ? (
								<ul aria-labelledby={`${id}-sites-label`} className="flex flex-col gap-1">
									{sites.sites.map((site) => {
										const current = site.id === currentSite;
										return (
											<li key={site.id}>
												<RowLink
													row={{ to: "/sites/$siteId", params: { siteId: site.id } }}
													onClick={onChosen}
													current={current ? "true" : undefined}
													className={cn(switcherRow, "h-11", current && "bg-accent text-accent-foreground")}
												>
													<span className="grid min-w-0 flex-1 leading-tight">
														<span className={cn("truncate", current && "font-medium")}>{site.name}</span>
														<span className="text-muted-foreground truncate font-mono text-xs">{site.slug}</span>
													</span>
													{current ? <CheckIcon className="size-4 shrink-0" aria-hidden="true" /> : null}
												</RowLink>
											</li>
										);
									})}
								</ul>
							) : (
								<p className="text-muted-foreground px-2 py-2 text-sm">{t("shell.switcher.noSites")}</p>
							)
						) : (
							<p role="status" className="text-muted-foreground px-2 py-2 text-sm">
								{sites?.state === "failed" ? t("shell.switcher.sitesFailed") : t("shell.switcher.loadingSites")}
							</p>
						)}
						<hr className="my-1 border-t" />
						{staff ||
						(place.level !== "install" &&
							place.workspace.id === shownWorkspace.id &&
							place.permissions.includes("site.create")) ? (
							<SwitcherLink
								to="/workspaces/$workspaceId"
								params={{ workspaceId: shownWorkspace.id }}
								icon={<PlusIcon aria-hidden="true" />}
								onChosen={onChosen}
							>
								{t("shell.switcher.newSite")}
							</SwitcherLink>
						) : null}
						<SwitcherLink
							to="/workspaces/$workspaceId/protected-terms"
							params={{ workspaceId: shownWorkspace.id }}
							icon={<SettingsIcon aria-hidden="true" />}
							onChosen={onChosen}
						>
							{t("shell.switcher.workspaceSettings")}
						</SwitcherLink>
					</div>
				) : null}
			</div>
		</div>
	);
}

const switcherRow =
	"hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-md px-2 outline-none transition-colors focus-visible:ring-3";

function SwitcherLink({
	to,
	params,
	icon,
	onChosen,
	children,
}: {
	to: "/workspaces" | "/workspaces/$workspaceId" | "/workspaces/$workspaceId/protected-terms";
	params?: Record<string, string>;
	icon: ReactNode;
	onChosen: () => void;
	children: ReactNode;
}) {
	return (
		<RowLink
			row={{ to, params: params ?? {} }}
			current={undefined}
			onClick={onChosen}
			className={cn(switcherRow, "[&_svg]:text-muted-foreground h-9 [&_svg]:size-4")}
		>
			{icon}
			<span className="truncate">{children}</span>
		</RowLink>
	);
}
