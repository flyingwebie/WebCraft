import { Link, useMatches } from "@tanstack/react-router";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@webcraft/ui/components/breadcrumb.tsx";
import { Fragment } from "react";

import { type MessageKey, useT } from "../i18n.tsx";
import { type AdminPlace, levelCrumbs } from "./levels.ts";
import { useNavigation, useRowLabel } from "./navigation.tsx";
import type { PageWidth } from "./page.tsx";

declare module "@tanstack/react-router" {
	interface StaticDataRouteOption {
		/** The page's name in the breadcrumbs, after the level it belongs to (or `crumb` from its loader). */
		crumb?: MessageKey;
		/**
		 * How wide the page's column is: `form` (720 px: settings and single records), `default` (1040 px:
		 * the usual list or dashboard) or `wide` (all of the main column: a library, an editor, a grid).
		 * The deepest route that says so decides; `default` when none does.
		 */
		width?: PageWidth;
	}
}

/**
 * The top bar's breadcrumbs: the level (the Install by its name, a Workspace, a Workspace and its
 * Site), the sidebar row whose secondary sidebar holds the page (Settings, Structure, Analytics), then
 * the page. Where the top bar is narrow (a phone) only the page is named.
 */
export function Breadcrumbs({ place, installName }: { place: AdminPlace; installName: string }) {
	const t = useT();
	const label = useRowLabel();
	const { position } = useNavigation();
	// A page names itself with `staticData.crumb`, or, when its name is data (a Post Type's, an
	// Entry's title), with `crumb` in what its loader answers.
	const pages = useMatches().flatMap((match) => {
		const named = (match.loaderData as { crumb?: unknown } | undefined)?.crumb;
		if (typeof named === "string") return [{ key: match.id, label: named, pathname: match.pathname }];
		const message = match.staticData.crumb;
		return message ? [{ key: match.id, label: t(message), pathname: match.pathname }] : [];
	});
	const parent = position.parent;
	const crumbs = [
		...levelCrumbs(place, installName).map((crumb) => ({
			key: `level-${crumb.label}-${String(crumb.to)}`,
			label: crumb.label,
			link: <Link to={crumb.to} params={crumb.params as never} />,
		})),
		// The row the page sits under, leading to the first page of its secondary sidebar.
		...(parent && parent.crumb !== null && pages.length > 0
			? [
					{
						key: `parent-${parent.id}`,
						label: parent.crumb ? t(parent.crumb) : label(parent.label),
						link: <Link to={parent.to} params={parent.params as never} />,
					},
				]
			: []),
		...pages.map((page) => ({ key: page.key, label: page.label, link: <Link to={page.pathname} /> })),
	];
	return (
		<Breadcrumb aria-label={t("shell.breadcrumbLabel")} className="min-w-0">
			<BreadcrumbList className="flex-nowrap gap-2 sm:gap-2">
				{crumbs.map((crumb, index) => {
					const last = index === crumbs.length - 1;
					return (
						<Fragment key={crumb.key}>
							{index > 0 ? <BreadcrumbSeparator className="hidden @2xl/bar:block" /> : null}
							{last ? (
								<BreadcrumbItem className="min-w-0">
									<BreadcrumbPage className="truncate font-medium">{crumb.label}</BreadcrumbPage>
								</BreadcrumbItem>
							) : (
								<BreadcrumbItem className="hidden whitespace-nowrap @2xl/bar:inline-flex">
									<BreadcrumbLink
										render={crumb.link}
										className="focus-visible:ring-ring/50 rounded-sm outline-none focus-visible:ring-3"
									>
										{crumb.label}
									</BreadcrumbLink>
								</BreadcrumbItem>
							)}
						</Fragment>
					);
				})}
			</BreadcrumbList>
		</Breadcrumb>
	);
}
