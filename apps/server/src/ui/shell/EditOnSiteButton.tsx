import { useMatches, useNavigate, useRouterState } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { ChevronDownIcon, EllipsisIcon, EyeIcon, ShieldIcon, SquarePenIcon } from "lucide-react";

import { useT } from "../i18n.tsx";
import { useOpenStaging } from "./StagingButton.tsx";

/** What the admin knows of the Entry on screen, enough to write its address on the Site. */
type EntryOnScreen = {
	entry: { language: string; draft: { slug: string; parentId?: string | null } };
	pages: readonly { id: string; slug: string; parentId: string | null }[] | null;
};
type PostTypeOnScreen = { postType: { urlPattern: string; builtIn: string | null } };
type SiteOnScreen = { place?: { level: string; languages?: { default: string } } };

const ENTRY_ROUTE = "/_admin/sites/$siteId/entries/$postTypeId/$entryId";
const POST_TYPE_ROUTE = "/_admin/sites/$siteId/entries/$postTypeId";

/**
 * The address on the Site of the page the admin shows: a Page's (its parents' slugs and its own) or
 * an Entry's (its Post Type's URL pattern with its slug), under its language's prefix; the home page
 * (`/`) on every other screen.
 */
export function useEditPath(): string {
	return useMatches({
		select: (matches) => {
			const entry = matches.find((match) => match.routeId === ENTRY_ROUTE)?.loaderData as EntryOnScreen | undefined;
			const postType = matches.find((match) => match.routeId === POST_TYPE_ROUTE)?.loaderData as
				| PostTypeOnScreen
				| undefined;
			if (!entry?.entry || !postType?.postType || !entry.entry.draft.slug) return "/";
			const place = [...matches].reverse().find((match) => (match.context as SiteOnScreen).place?.level === "site")
				?.context as SiteOnScreen | undefined;
			const path = postType.postType.builtIn === "page" ? pagePath(entry) : entryPath(postType, entry);
			const defaultLanguage = place?.place?.languages?.default;
			if (!defaultLanguage || entry.entry.language === defaultLanguage) return path;
			return `/${entry.entry.language.toLowerCase()}${path === "/" ? "" : path}`;
		},
	});
}

function pagePath({ entry, pages }: EntryOnScreen): string {
	const slugs = [entry.draft.slug];
	const seen = new Set<string>();
	let parent = entry.draft.parentId ?? null;
	while (parent && !seen.has(parent)) {
		seen.add(parent);
		const page = pages?.find((candidate) => candidate.id === parent);
		if (!page) break;
		slugs.unshift(page.slug);
		parent = page.parentId;
	}
	return `/${slugs.map(encodeURIComponent).join("/")}`;
}

function entryPath({ postType }: PostTypeOnScreen, { entry }: EntryOnScreen): string {
	return postType.urlPattern.includes("{slug}")
		? postType.urlPattern.replace("{slug}", encodeURIComponent(entry.draft.slug))
		: "/";
}

/**
 * Opens a page of the Site in the building area (ADR 0037), on the Site's own address in Edit mode
 * (ADR 0022), through the admin's one way in (`/sites/$siteId/build`), whose logo tile comes back to
 * the screen the person was on. Safe mode is Edit mode with none of the Site's own scripts, for when
 * a broken one gets in the way.
 */
function useOpenEditMode(siteId: string): { open(path: string, safeMode: boolean): void } {
	const navigate = useNavigate();
	// Path and query only: the way in refuses a `returnTo` with a fragment (the skip link's `#main`).
	const here = useRouterState({ select: (state) => `${state.location.pathname}${state.location.searchStr}` });
	const open = (path: string, safeMode: boolean) => {
		void navigate({
			to: "/sites/$siteId/build",
			params: { siteId },
			search: { open: `/page${path}`, returnTo: here, ...(safeMode ? { safe: true } : {}) },
		});
	};
	return { open };
}

/**
 * "Edit on site": opens the page the person is on (a Page or an Entry), or the Site's home page
 * from any other screen, in the building area. Its menu opens Safe mode instead.
 */
export function EditOnSiteButton({ siteId, className }: { siteId: string; className?: string }) {
	const t = useT();
	const path = useEditPath();
	const { open } = useOpenEditMode(siteId);
	return (
		<div className={`flex ${className ?? ""}`}>
			<Button variant="outline" size="sm" className="rounded-e-none" onClick={() => open(path, false)}>
				<SquarePenIcon aria-hidden="true" />
				{t("site.editOnSite")}
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							variant="outline"
							size="icon-sm"
							className="rounded-s-none border-s-0"
							aria-label={t("site.editOptions")}
						/>
					}
				>
					<ChevronDownIcon aria-hidden="true" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-auto min-w-64">
					<DropdownMenuItem onClick={() => open(path, true)}>
						<ShieldIcon aria-hidden="true" />
						<span className="grid">
							<span>{t("site.editInSafeMode")}</span>
							<span className="text-muted-foreground text-xs">{t("site.editInSafeModeHelp")}</span>
						</span>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/**
 * Staging and Edit on site where the top bar is narrow (a phone): one button, named "More for this
 * Site", opening them as a menu, so the bar keeps to one line.
 */
export function SiteActionsMenu({
	siteId,
	staging,
	edit,
	className,
}: {
	siteId: string;
	staging: boolean;
	edit: boolean;
	className?: string;
}) {
	const t = useT();
	const path = useEditPath();
	const editMode = useOpenEditMode(siteId);
	const stage = useOpenStaging(siteId);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="outline"
						size="icon-sm"
						className={className}
						aria-label={t("shell.siteActions")}
						disabled={stage.opening}
					/>
				}
			>
				<EllipsisIcon aria-hidden="true" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-auto min-w-56">
				{staging ? (
					<DropdownMenuItem onClick={() => stage.open("/")}>
						<EyeIcon aria-hidden="true" />
						{t("staging.button")}
					</DropdownMenuItem>
				) : null}
				{edit ? (
					<>
						<DropdownMenuItem onClick={() => editMode.open(path, false)}>
							<SquarePenIcon aria-hidden="true" />
							{t("site.editOnSite")}
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => editMode.open(path, true)}>
							<ShieldIcon aria-hidden="true" />
							{t("site.editInSafeMode")}
						</DropdownMenuItem>
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
