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
		/** The page's name in the breadcrumbs, after the level it belongs to. */
		crumb?: MessageKey;
		/** The page uses the full width of the window (a library or editor), not the reading width. */
		wide?: boolean;
	}
}

/** The top bar's breadcrumbs: the level (the Install, a Workspace, a Workspace and its Site), then the page. */
export function Breadcrumbs({ place }: { place: AdminPlace }) {
	const t = useT();
	const pages = useMatches().filter((match) => match.staticData.crumb);
	const crumbs = [
		...levelCrumbs(place, t("shell.levels.install")).map((crumb) => ({
			key: `level-${crumb.label}-${String(crumb.to)}`,
			label: crumb.label,
			link: <Link to={crumb.to} params={crumb.params as never} />,
		})),
		...pages.map((match) => ({
			key: match.id,
			label: t(match.staticData.crumb as MessageKey),
			link: <Link to={match.pathname} />,
		})),
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
