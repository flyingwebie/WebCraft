import type { ComponentType } from "react";

import { useT } from "../i18n.tsx";
import { PageHeader } from "../PageHeader.tsx";
import type { AdminPlace } from "../shell/levels.ts";

/** What a Module's admin page gets: where it is, and which of the Module's pages it is. */
export type ModulePageProps = { place: AdminPlace; moduleId: string; path: string };

/**
 * The screens of first-party Modules' admin pages, by Module id and page path. A first-party
 * Module ships its screen in its package (built from WebCraft's own UI pieces) and adds it here;
 * the shell shows it at `/sites/<id>/m/<module>/<path>` (or the Workspace's) wherever the Module
 * runs and the person holds the page's Permission. Third-party Modules will never be loaded into
 * the admin page (ADR 0024). This version has none yet.
 */
export const MODULE_PAGES: Readonly<Record<string, Readonly<Record<string, ComponentType<ModulePageProps>>>>> = {};

/** A Module's admin page in the shell, or a plain notice when this version of the admin has no screen for it. */
export function ModulePage({ place, moduleId, path }: ModulePageProps) {
	const t = useT();
	const pages = place.level === "install" ? [] : place.modulePages;
	const page = pages.find((candidate) => candidate.moduleId === moduleId && candidate.path === path);
	const Screen = MODULE_PAGES[moduleId]?.[path];
	if (page && Screen) return <Screen place={place} moduleId={moduleId} path={path} />;
	return <PageHeader heading={page?.label ?? t("modules.page.heading")}>{t("modules.page.body")}</PageHeader>;
}
