import { useEffect, useState } from "react";
import { getApi } from "../api.ts";
import { useEditorAnnouncement } from "../builder/use-editor-announcement.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
/** Staff's Site switch and per-Component allowance, changing Structure rather than Content. */
export function PageLayoutSettings({
	siteId,
	components,
}: {
	siteId: string;
	components: readonly { id: string; name: string }[];
}) {
	const t = useT();
	const [, announce] = useEditorAnnouncement();
	const [settings, setSettings] = useState<{ enabled: boolean; allowedComponents: string[] } | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let live = true;
		void getApi()
			.then((api) => api.pageLayouts.settings({ siteId }))
			.then((value) => {
				if (live) setSettings(value);
			})
			.catch((error) => {
				if (live) announce(t(errorMessage(error)), "interrupt");
			});
		return () => {
			live = false;
		};
	}, [siteId, t, announce]);
	async function save(change: { enabled?: boolean; allowedComponents?: string[] }) {
		const before = settings;
		setBusy(true);
		if (before) setSettings({ ...before, ...change });
		try {
			setSettings(await (await getApi()).pageLayouts.configure({ siteId, ...change }));
		} catch (error) {
			setSettings(before);
			announce(t(errorMessage(error)), "interrupt");
		} finally {
			setBusy(false);
		}
	}
	if (!settings) return null;
	return (
		<fieldset className="mb-6 grid gap-3 rounded border p-4" disabled={busy}>
			<legend className="px-2 font-medium">{t("pageLayout.title")}</legend>
			<label className="flex items-center gap-2">
				<input
					type="checkbox"
					checked={settings.enabled}
					onChange={(event) => void save({ enabled: event.target.checked })}
				/>
				{t("pageLayout.enabled")}
			</label>
			<div className="flex flex-wrap gap-4">
				{components.map((c) => (
					<label key={c.id} className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={settings.allowedComponents.includes(c.id)}
							onChange={(event) =>
								void save({
									allowedComponents: event.target.checked
										? [...settings.allowedComponents, c.id]
										: settings.allowedComponents.filter((id) => id !== c.id),
								})
							}
						/>
						{c.name} · {t("pageLayout.allowed")}
					</label>
				))}
			</div>
		</fieldset>
	);
}
