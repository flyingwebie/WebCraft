import type { BuildingAreaApiClient } from "@webcraft/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fill, type Words } from "../../api.ts";
import { type GoToData, managementApi } from "../../management.ts";

/** A Component as `components.list` answers it: its versions, and where it is used. */
export type ComponentRow = Awaited<ReturnType<BuildingAreaApiClient["components"]["list"]>>["components"][number];

/** Where a Component is placed (`usage.usedIn`). */
export type ComponentUse = ComponentRow["usage"]["usedIn"][number];

/** What the Components place shows. */
export type ComponentsData =
	| {
			components: readonly ComponentRow[];
			/** The Allowed components (`pageLayouts.settings`): what Members may add to a Page. */
			allowed: ReadonlySet<string>;
			/** Go to's lists, to name the Pages, Entries and Post Types a Component is used on. */
			goTo: GoToData;
	  }
	| { forbidden: true };

/** The reason a call failed, as a code (`network` when the server didn't answer one). */
export function codeOf(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : "network";
}

/** Why a change was refused, in the person's words. */
export function reasonText(words: Words, error: unknown): string {
	const shown = words.components.reasons;
	const code = codeOf(error);
	switch (code) {
		case "COMPONENT_NAME_TAKEN":
			return shown.taken;
		case "COMPONENT_INVALID":
			return shown.invalid;
		case "CONFIRMATION_INVALID":
			return shown.confirmation;
		case "FORBIDDEN":
			return shown.forbidden;
		case "network":
			return shown.network;
		default:
			return fill(shown.generic, { code });
	}
}

/** "4 pages", in the person's language. */
export function counted(forms: { one: string; other: string }, count: number, language: string): string {
	return fill(forms[new Intl.PluralRules(language).select(count) === "one" ? "one" : "other"], {
		count: String(count),
	});
}

/** What a use is called: the Page's title, "Entry template · Blog posts", "Component · PageIntro". */
export function nameOfUse(words: Words, use: ComponentUse, goTo: GoToData): string {
	const shown = words.components;
	const postTypeName = (id: string | null) => goTo.postTypes.find((postType) => postType.id === id)?.name ?? "";
	let name: string;
	switch (use.kind) {
		case "entry": {
			const entry =
				goTo.pages.find((page) => page.id === use.id) ??
				goTo.postTypes.flatMap((postType) => postType.entries).find((each) => each.id === use.id);
			name = entry?.title || shown.useEntry;
			break;
		}
		case "template": {
			const kind = use.templateKind as string;
			name =
				kind === "site"
					? shown.useSiteTemplate
					: kind === "search"
						? shown.useSearchTemplate
						: fill(kind === "archive" ? shown.useArchiveTemplate : shown.useEntryTemplate, {
								postType: postTypeName(use.postTypeId),
							});
			break;
		}
		case "component":
			name = fill(shown.useComponent, { name: use.name });
			break;
		case "popup":
			name = fill(shown.usePopup, { name: use.name });
			break;
	}
	// Placed only in a Draft: nobody sees it there yet.
	return use.versions.includes("published") ? name : fill(shown.draftOnly, { name });
}

/** The uses in the order the place names them: Pages and Entries first, then Templates, Components and Popups. */
export function orderedUses(usedIn: readonly ComponentUse[]): ComponentUse[] {
	const rank = { entry: 0, template: 1, component: 2, popup: 3 } as const;
	return [...usedIn].sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/** What reading the place gives: its data (null until read), a failure, and reading again. */
export type ComponentsState = {
	data: ComponentsData | null;
	failed: string | null;
	reload(): Promise<void>;
	/** Takes the Allowed components as a change answered them. */
	setAllowed(allowed: readonly string[]): void;
	api: BuildingAreaApiClient;
};

/**
 * Reads the Components place each time it opens: the Site's Components (and its Modules') with where
 * each is used, the Allowed components, and Go to's lists for the names of what uses them.
 */
export function useComponentsData(token: string, siteId: string): ComponentsState {
	const api = useMemo(() => managementApi(token), [token]);
	const [data, setData] = useState<ComponentsData | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const alive = useRef(true);

	const read = useCallback(async () => {
		let components: ComponentRow[];
		try {
			components = (await api.components.list({ siteId })).components;
		} catch (error) {
			if (codeOf(error) !== "FORBIDDEN") throw error;
			if (alive.current) setData({ forbidden: true });
			return;
		}
		const [settings, goTo] = await Promise.all([
			api.pageLayouts.settings({ siteId }),
			api.builder.commandMenu({ siteId }),
		]);
		if (!alive.current) return;
		setData({ components, allowed: new Set(settings.allowedComponents), goTo });
		setFailed(null);
	}, [api, siteId]);

	useEffect(() => {
		alive.current = true;
		read().catch((error: unknown) => {
			if (alive.current) setFailed(codeOf(error));
		});
		return () => {
			alive.current = false;
		};
	}, [read]);

	const setAllowed = useCallback((allowed: readonly string[]) => {
		setData((current) => (current && !("forbidden" in current) ? { ...current, allowed: new Set(allowed) } : current));
	}, []);

	return { data, failed, reload: read, setAllowed, api };
}
