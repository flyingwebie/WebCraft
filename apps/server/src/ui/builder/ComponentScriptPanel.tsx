import type { ComponentScriptVersion } from "@webcraft/core";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { useEffect, useRef, useState } from "react";
import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { applyCodeKey } from "./apply-code-key.ts";
import { componentScriptSettings } from "./component-script-settings.ts";
import { useEditorAnnouncement } from "./use-editor-announcement.ts";

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
	const [message, setMessage] = useEditorAnnouncement();
	const [conflict, setConflict] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const saving = useRef(false);
	const settingsHost = useRef<HTMLDivElement>(null);
	const latest = useRef(draft);
	const reloadScript = useRef<() => Promise<boolean>>(async () => false);
	latest.current = draft;
	const title = t("editBar.codeMode.componentScript", { name });
	useEffect(() => {
		let current = true;
		const controls = componentScriptSettings({
			document,
			word: (key) => t(`editBar.codeMode.${key}` as "editBar.codeMode.consentCategory"),
			changed: () => {
				if (!latest.current) return;
				const next = { ...latest.current, ...controls.get() } as ComponentScriptVersion;
				latest.current = next;
				setDraft(next);
			},
		});
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
	}, [siteId, componentId, t, setMessage]);
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
				setMessage(t("editBar.codeMode.conflictText", { name: title }), "interrupt");
			} else setMessage(t(errorMessage(error)), "interrupt");
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
		<section data-editor-region="js" aria-label="JS" className="flex min-h-0 flex-col gap-2 overflow-auto border-s p-3">
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
				<div aria-live="off" className="grid gap-2 text-sm">
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
				data-editor-default-focus=""
				data-editor-code=""
				aria-label={t("editBar.codeMode.jsOf", { name: title })}
				value={draft?.code ?? ""}
				readOnly={!draft}
				spellCheck={false}
				className="min-h-32 flex-1 font-mono text-xs"
				onChange={(event) => {
					if (latest.current) {
						const next = { ...latest.current, code: event.target.value };
						latest.current = next;
						setDraft(next);
					}
				}}
				onKeyDown={(event) => {
					if (
						applyCodeKey(event, (text) => {
							if (!latest.current) return;
							latest.current = { ...latest.current, code: text };
							setDraft(latest.current);
						})
					)
						return;

					if ((event.metaKey || event.ctrlKey) && event.key === "s") {
						event.preventDefault();
						event.stopPropagation();
						void save();
					}
				}}
			/>
			<p className="text-muted-foreground text-xs">{t("builder.scriptPreview")}</p>
			<p role="status" aria-live="off" className="text-sm">
				{message}
			</p>
		</section>
	);
}
