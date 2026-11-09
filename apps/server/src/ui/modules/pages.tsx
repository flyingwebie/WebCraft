import type { ComponentType } from "react";

import { useT } from "../i18n.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { RedirectsScreen, redirectsData } from "../redirects/Redirects.tsx";
import type { AdminPlace } from "../shell/levels.ts";

/**
 * What a Module's admin page gets: where it is, which of the Module's pages it is, what its `load`
 * answered (on the server first, again after `router.invalidate()`), and the address's `tab`.
 */
export type ModulePageProps = { place: AdminPlace; moduleId: string; path: string; data?: unknown; tab?: string };

/** A first-party Module's admin screen, and what it loads for its place (a Site's or Workspace's id). */
export type ModuleScreen = {
	Screen: ComponentType<ModulePageProps>;
	load?(placeId: string): Promise<unknown>;
};

/**
 * The screens of first-party Modules' admin pages, by Module id and page path. A first-party
 * Module's screen is built from WebCraft's own UI pieces in the admin (`ui/<module>/`) and added
 * here; the shell shows it at `/sites/<id>/m/<module>/<path>` (or the Workspace's) wherever the
 * Module runs and the person holds the page's Permission. Third-party Modules will never be loaded
 * into the admin page (ADR 0024).
 */
export const MODULE_PAGES: Readonly<Record<string, Readonly<Record<string, ModuleScreen>>>> = {
	redirects: { redirects: { Screen: RedirectsScreen, load: redirectsData } },
};

/** A Module's admin page in the shell, or a plain notice when this version of the admin has no screen for it. */
export function ModulePage({ place, moduleId, path, data, tab }: ModulePageProps) {
	const t = useT();
	const pages = place.level === "install" ? [] : place.modulePages;
	const page = pages.find((candidate) => candidate.moduleId === moduleId && candidate.path === path);
	const screen = MODULE_PAGES[moduleId]?.[path];
	if (page && screen) return <screen.Screen place={place} moduleId={moduleId} path={path} data={data} tab={tab} />;
	return <PageHeader heading={page?.label ?? t("modules.page.heading")}>{t("modules.page.body")}</PageHeader>;
}
