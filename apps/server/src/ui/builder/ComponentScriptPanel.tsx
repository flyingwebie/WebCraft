import type { ComponentScriptVersion } from "@webcraft/core";
import { type Json, reverseChange } from "@webcraft/core/draft-document";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { componentScriptSettings } from "./component-script-settings.ts";
import { editorHistory } from "./editor-history.ts";

/** Edits the real Component script Draft; the Builder's sandbox remains scriptless. */
export function ComponentScriptPanel({
	siteId,
	componentId,
	name,
	departure,
}: {
	siteId: string;
	componentId: string;
	name: string;
	departure: { current: (() => Promise<boolean>) | null };
}) {
	const t = useT();
	const [draft, setDraft] = useState<ComponentScriptVersion | null>(null);
	const [version, setVersion] = useState<string | null>(null);
	const [saved, setSaved] = useState("");
	const [message, setMessage] = useState("");
	const [conflict, setConflict] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const saving = useRef(false);
	const settingsHost = useRef<HTMLDivElement>(null);
	const settings = useRef<ReturnType<typeof componentScriptSettings> | null>(null);
	const libraryChoices = useRef<{ id: string; name: string }[]>([]);
	const latest = useRef(draft);
	const reloadScript = useRef<() => Promise<boolean>>(async () => false);
	latest.current = draft;
	const history = editorHistory();
	const historyKey = `script:${siteId}:component:${componentId}`;
	const savedRef = useRef(saved);
	savedRef.current = saved;
	const title = t("editBar.codeMode.componentScript", { name });
	const record = useCallback(
		(next: ComponentScriptVersion, typing = false) => {
			if (latest.current)
				history.record({
					resource: historyKey,
					before: latest.current as unknown as Json,
					after: next as unknown as Json,
					label: t("editorHistory.js", { name }),
					location: { siteId, title: name, panel: "js" },
					group: typing ? historyKey : undefined,
				});
			latest.current = next;
			setDraft(next);
		},
		[history, historyKey, name, siteId, t],
	);
	useEffect(
		() =>
			history.register(historyKey, {
				reverse: async (from, to) => {
					const started = Date.now();
					while (saving.current && Date.now() - started < 10000)
						await new Promise((resolve) => setTimeout(resolve, 20));
					if (saving.current || !latest.current) return { ok: false, code: "HISTORY_UNAVAILABLE" };
					const api = await getApi();
					const { script } = await api.components.getScript({ siteId, componentId });
					const pending = JSON.stringify(latest.current) !== savedRef.current;
					const before = pending
						? latest.current
						: (script?.draft ?? { code: "", consentCategory: "necessary", libraryIds: [] });
					const localAtStart = latest.current;
					let after: ComponentScriptVersion;
					try {
						after = reverseChange(from, to, before as unknown as Json) as unknown as ComponentScriptVersion;
					} catch {
						return { ok: false, code: "HISTORY_OBSOLETE" };
					}
					if (!pending) {
						const stored = await api.components.saveScriptDraft({
							siteId,
							componentId,
							...after,
							basedOn: script?.version ?? null,
						});
						setVersion(stored.script.version);
						setSaved(JSON.stringify(after));
					}
					if (latest.current === localAtStart) {
						latest.current = after;
						setDraft(after);
						settings.current?.set({ ...after, libraries: libraryChoices.current });
					}
					return { ok: true, before: before as unknown as Json, after: after as unknown as Json };
				},
			}),
		[history, historyKey, siteId, componentId],
	);
	useEffect(() => {
		let current = true;
		const controls = componentScriptSettings({
			document,
			word: (key) => t(`editBar.codeMode.${key}` as "editBar.codeMode.consentCategory"),
			changed: () => {
				if (!latest.current) return;
				const next = { ...latest.current, ...controls.get() } as ComponentScriptVersion;
				record(next);
			},
		});
		settings.current = controls;
		settingsHost.current?.replaceChildren(controls.root);
		const load = async () => {
			const before = latest.current;
			const api = await getApi();
			const [{ script }, { libraries }] = await Promise.all([
				api.components.getScript({ siteId, componentId }),
				api.libraries.list({ siteId }),
			]);
			if (!current || latest.current !== before) return false;
			const next = script?.draft ?? { code: "", consentCategory: "necessary" as const, libraryIds: [] };
			latest.current = next;
			setDraft(next);
			setVersion(script?.version ?? null);
			setSaved(JSON.stringify(next));
			libraryChoices.current = libraries;
			controls.set({ ...next, libraries });
			return true;
		};
		reloadScript.current = load;
		void load().catch((error) => {
			if (current) setMessage(t(errorMessage(error)));
		});
		return () => {
			current = false;
			controls.root.remove();
		};
	}, [siteId, componentId, t, record]);
	const save = async (over?: string): Promise<boolean> => {
		const next = latest.current;
		if (!next || saving.current) return false;
		if (over === undefined && JSON.stringify(next) === saved) return true;
		saving.current = true;
		setBusy(true);
		try {
			const { script } = await (await getApi()).components.saveScriptDraft({
				siteId,
				componentId,
				...next,
				basedOn: over ?? version,
			});
			setVersion(script.version);
			setSaved(JSON.stringify(next));
			setConflict(null);
			setMessage(t("editBar.codeMode.savedName", { name: title }));
			return latest.current === next;
		} catch (error) {
			const refused = error as { code?: string; data?: { version?: string } };
			if (refused.code === "CHANGED_MEANWHILE" && refused.data?.version) {
				setConflict(refused.data.version);
				setMessage("");
			} else setMessage(t(errorMessage(error)));
			return false;
		} finally {
			saving.current = false;
			setBusy(false);
		}
	};
	const reload = async () => {
		if (saving.current) return;
		saving.current = true;
		setBusy(true);
		try {
			if (await reloadScript.current()) {
				setConflict(null);
				setMessage("");
			}
		} catch (error) {
			setMessage(t(errorMessage(error)));
		} finally {
			saving.current = false;
			setBusy(false);
		}
	};
	const saveNow = useRef(save);
	saveNow.current = save;
	useEffect(() => {
		departure.current = () => saveNow.current();
		return () => {
			departure.current = null;
		};
	}, [departure]);
	return (
		<section aria-label="JS" className="flex min-h-0 flex-col gap-2 overflow-auto border-s p-3">
			<div className="flex items-center justify-between gap-2">
				<h2 className="text-sm font-semibold">JS</h2>
				<fieldset aria-label={t("editBar.codeMode.scriptSource")}>
					<Button size="sm" variant="secondary" aria-pressed="true">
						{t("editBar.codeMode.componentTab")}
					</Button>
				</fieldset>
				<Button size="sm" variant="outline" disabled={!draft || busy} onClick={() => void save()}>
					{t("editBar.codeMode.save")}
				</Button>
			</div>
			<div ref={settingsHost} />
			{conflict !== null ? (
				<div role="alert" className="grid gap-2 text-sm">
					<p>{t("editBar.codeMode.conflictText", { name: title })}</p>
					<div className="flex flex-wrap gap-2">
						<Button size="sm" variant="outline" disabled={busy} onClick={() => void reload()}>
							{t("editBar.codeMode.reload")}
						</Button>
						<Button size="sm" variant="destructive" disabled={busy} onClick={() => void save(conflict)}>
							{t("editBar.codeMode.overwrite")}
						</Button>
					</div>
				</div>
			) : null}
			<Textarea
				aria-label={t("editBar.codeMode.jsOf", { name: title })}
				value={draft?.code ?? ""}
				readOnly={!draft}
				spellCheck={false}
				className="min-h-32 flex-1 font-mono text-xs"
				onChange={(event) => {
					if (latest.current) {
						const next = { ...latest.current, code: event.target.value };
						record(next, true);
					}
				}}
				onBlur={() => history.boundary()}
				onKeyDown={(event) => {
					if ((event.metaKey || event.ctrlKey) && event.key === "s") {
						event.preventDefault();
						event.stopPropagation();
						void save();
					}
				}}
			/>
			<p className="text-muted-foreground text-xs">{t("builder.scriptPreview")}</p>
			<p role="status" className="text-sm">
				{message}
			</p>
		</section>
	);
}
