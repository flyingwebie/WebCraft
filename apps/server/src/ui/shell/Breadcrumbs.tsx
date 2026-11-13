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

declare module "@tanstack/react-router" {
	interface StaticDataRouteOption {
		/** The page's name in the breadcrumbs, after the level it belongs to (or `crumb` from its loader). */
		crumb?: MessageKey;
		/** The page uses the full width of the window (a library or editor), not the reading width. */
		wide?: boolean;
	}
}

/** The top bar's breadcrumbs: the level (the Install, a Workspace, a Workspace and its Site), then the page. */
export function Breadcrumbs({ place }: { place: AdminPlace }) {
	const t = useT();
	// A page names itself with `staticData.crumb`, or, when its name is data (a Post Type's, an
	// Entry's title), with `crumb` in what its loader answers.
	const pages = useMatches().flatMap((match) => {
		const named = (match.loaderData as { crumb?: unknown } | undefined)?.crumb;
		if (typeof named === "string") return [{ key: match.id, label: named, pathname: match.pathname }];
		const message = match.staticData.crumb;
		return message ? [{ key: match.id, label: t(message), pathname: match.pathname }] : [];
	});
	const crumbs = [
		...levelCrumbs(place, t("shell.levels.install")).map((crumb) => ({
			key: `level-${crumb.label}-${String(crumb.to)}`,
			label: crumb.label,
			link: <Link to={crumb.to} params={crumb.params as never} />,
		})),
		...pages.map((page) => ({ key: page.key, label: page.label, link: <Link to={page.pathname} /> })),
	];
	return (
		<Breadcrumb aria-label={t("shell.breadcrumbLabel")}>
			<BreadcrumbList>
				{crumbs.map((crumb, index) => {
					const last = index === crumbs.length - 1;
					return (
						<Fragment key={crumb.key}>
							{index > 0 ? <BreadcrumbSeparator /> : null}
							<BreadcrumbItem>
								{last ? (
									<BreadcrumbPage>{crumb.label}</BreadcrumbPage>
								) : (
									<BreadcrumbLink render={crumb.link}>{crumb.label}</BreadcrumbLink>
								)}
							</BreadcrumbItem>
						</Fragment>
					);
				})}
			</BreadcrumbList>
		</Breadcrumb>
	);
}
