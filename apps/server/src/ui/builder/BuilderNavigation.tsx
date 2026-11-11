import { Button } from "@webcraft/ui/components/button.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import type { BuilderTarget } from "./model.ts";

type Destinations = Awaited<ReturnType<Awaited<ReturnType<typeof getApi>>["builder"]["destinations"]>>;
export type ReturnPage = { path: string; title: string; ref: string };

/** Both the lists and the Builder enter through the Site-bound one-use handoff. */
export function BuilderNavigation({ siteId, target, entryId, onEntry, selection, beforeLeave, returnPage, list = false }: {
	siteId: string; target: BuilderTarget; entryId?: string; onEntry?(id: string): void;
	selection?: string | null; beforeLeave?(): Promise<boolean>; returnPage?: ReturnPage; list?: boolean;
}) {
	const t = useT();
	const [destinations, setDestinations] = useState<Destinations | null>(null);
	const [entries, setEntries] = useState<{ id: string; title: string }[]>([]);
	const [choice, setChoice] = useState("");
	const [placement, setPlacement] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let current = true;
		setDestinations(null);
		void getApi().then((api) => api.builder.destinations({ siteId, target, entryId: entryId || undefined })).then((found) => {
			if (current) { setDestinations(found); setChoice(found.pages[0]?.path ?? ""); setPlacement(found.pages[0]?.refs[0] ?? ""); }
		}).catch((error) => { if (current) toast.error(t(errorMessage(error))); });
		return () => { current = false; };
	}, [siteId, target, entryId, t]);
	useEffect(() => {
		if (target.kind !== "entryTemplate" || !onEntry) return;
		let current = true;
		void getApi().then((api) => api.entries.list({ siteId, postTypeId: target.postTypeId })).then((found) => {
			if (current) setEntries(found.entries.map((entry) => ({ id: entry.id, title: entry.draft.title })));
		});
		return () => { current = false; };
	}, [siteId, target, onEntry]);
	const page = destinations?.pages.find((page) => page.path === choice);
	const open = async (back?: ReturnPage) => {
		if (busy || (!back && !page)) return;
		setBusy(true);
		try {
			if (beforeLeave && !(await beforeLeave())) return;
			const path = back?.path ?? page!.path;
			const ref = back?.ref ?? (returnPage?.path === path && page?.refs.includes(returnPage.ref) ? returnPage.ref : placement);
			const { url } = await (await getApi()).editMode.open({ siteId, path, code: true, selection: selection ? `${ref}#${selection}` : ref });
			window.location.assign(url);
		} catch (error) { toast.error(t(errorMessage(error))); }
		finally { setBusy(false); }
	};
	return <div className="flex flex-wrap items-center gap-2">
		{returnPage ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void open(returnPage)}>{t("builder.navigation.back", { page: returnPage.title })}</Button> : null}
		{target.kind === "entryTemplate" && onEntry ? <NativeSelect aria-label={t("builder.navigation.entry")} value={entryId || ""} onChange={(event) => onEntry(event.target.value)}>
			<NativeSelectOption value="">{t("builder.navigation.newest")}</NativeSelectOption>
			{entries.map((entry) => <NativeSelectOption key={entry.id} value={entry.id}>{entry.title}</NativeSelectOption>)}
		</NativeSelect> : null}
		{target.kind === "component" && destinations?.pages.length ? <>
			<NativeSelect aria-label={t("builder.navigation.pages", { count: destinations.pages.length })} value={choice} onChange={(event) => { setChoice(event.target.value); setPlacement(destinations.pages.find((p) => p.path === event.target.value)?.refs[0] ?? ""); }}>
				{destinations.pages.map((p) => <NativeSelectOption key={p.path} value={p.path}>{p.title} · {p.path}</NativeSelectOption>)}
			</NativeSelect>
			{page && page.refs.length > 1 ? <NativeSelect aria-label={t("builder.navigation.placement")} value={placement} onChange={(event) => setPlacement(event.target.value)}>{page.refs.map((ref) => <NativeSelectOption key={ref} value={ref}>{ref}</NativeSelectOption>)}</NativeSelect> : null}
		</> : null}
		<Button size="sm" variant="outline" disabled={busy || !page} onClick={() => void open()}>{t(list ? "site.editOnSite" : "builder.navigation.view")}</Button>
		{destinations?.reason ? <span className="text-muted-foreground text-xs">{t(`builder.navigation.${destinations.reason}`)}</span> : null}
	</div>;
}
