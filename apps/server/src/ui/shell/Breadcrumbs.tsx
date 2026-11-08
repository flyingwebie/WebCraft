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
import { type AdminPlace, LEVEL_HOMES, LEVEL_LABELS } from "./levels.ts";

declare module "@tanstack/react-router" {
	interface StaticDataRouteOption {
		/** The page's name in the breadcrumbs, after the level it belongs to. */
		crumb?: MessageKey;
	}
}

/** The top bar's breadcrumbs: the level (Install, Workspace, Site), then the page. */
export function Breadcrumbs({ place }: { place: AdminPlace }) {
	const t = useT();
	const pages = useMatches().filter((match) => match.staticData.crumb);
	return (
		<Breadcrumb aria-label={t("shell.breadcrumbLabel")}>
			<BreadcrumbList>
				<BreadcrumbItem>
					<BreadcrumbLink render={<Link to={LEVEL_HOMES[place.level]} />}>
						{t(LEVEL_LABELS[place.level])}
					</BreadcrumbLink>
				</BreadcrumbItem>
				{pages.map((match, index) => {
					const label = t(match.staticData.crumb as MessageKey);
					const last = index === pages.length - 1;
					return (
						<Fragment key={match.id}>
							<BreadcrumbSeparator />
							<BreadcrumbItem>
								{last ? (
									<BreadcrumbPage>{label}</BreadcrumbPage>
								) : (
									<BreadcrumbLink render={<Link to={match.pathname} />}>{label}</BreadcrumbLink>
								)}
							</BreadcrumbItem>
						</Fragment>
					);
				})}
			</BreadcrumbList>
		</Breadcrumb>
	);
}
