import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorCode, errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import type { MediaItem } from "../media/preview.ts";
import { useAutosave } from "./autosave.ts";
import {
	DraftStatusCard,
	LanguageTabs,
	SaveErrorBanner,
	SaveStatusText,
	StatusBadge,
	useDraftPublish,
} from "./DraftParts.tsx";
import { FieldValueList, type ValueContext } from "./FieldValues.tsx";
import type { FieldValues, GlobalsView, Json, Problem } from "./model.ts";

/**
 * The Globals editor: the Site's site-wide values (phone, address, footer text), which every Template
 * reads as `site.x`. Like an Entry's, changes save to the Draft by themselves and go live when
 * published; Staff define the Fields on the Post Types & Fields screen.
 */
export function GlobalsEditor({
	siteId,
	globals: loaded,
	permissions,
	languages,
	media: knownMedia,
}: {
	siteId: string;
	globals: GlobalsView;
	permissions: readonly string[];
	languages: { default: string; all: readonly string[] };
	media: Readonly<Record<string, MediaItem>>;
}) {
	const t = useT();
	const router = useRouter();
	const [globals, setGlobals] = useState(loaded);
	const [values, setValues] = useState(() => loaded.draft as FieldValues);
	const [refused, setRefused] = useState<Problem[]>([]);
	const [saveError, setSaveError] = useState<MessageKey | null>(null);
	const [media, setMedia] = useState(knownMedia);
	const canPublish = permissions.includes("entry.publish");

	const autosave = useAutosave<Record<string, Json>>({
		merge: (older, newer) => ({ ...older, ...newer }),
		save: async (fields) => {
			const api = await getApi();
			const { globals: saved } = await api.globals.saveDraft({ siteId, language: globals.language, fields });
			setGlobals(saved);
			setRefused([]);
			setSaveError(null);
		},
		onFailed: (error) => {
			const data = (error as { data?: { problems?: Problem[] } }).data;
			if (errorCode(error) === "GLOBALS_INVALID" && data?.problems) setRefused(data.problems);
			setSaveError(errorMessage(error));
		},
	});

	const problems = [...globals.problems, ...refused];
	const context: ValueContext = {
		siteId,
		idPrefix: "globals",
		language: globals.language,
		defaultLanguage: languages.default,
		problems,
		relationships: {},
		media,
		onMediaChosen: (item) => setMedia((before) => ({ ...before, [item.id]: item })),
		markShared: true,
	};

	const publishing = useDraftPublish({
		flush: autosave.flush,
		invalid: ["GLOBALS_INVALID", "GLOBALS_INCOMPLETE"],
		publish: async () => {
			const api = await getApi();
			const { globals: published } = await api.globals.publish({ siteId });
			setGlobals(published);
			toast.success(t("globals.published"));
			await router.invalidate();
		},
	});

	return (
		<div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_20rem]">
			<div className="grid min-w-0 content-start gap-6">
				<div className="grid gap-1">
					<div className="flex flex-wrap items-center gap-3">
						<h1 className="text-2xl font-semibold tracking-tight">{t("globals.heading")}</h1>
						<StatusBadge status={globals.status} />
					</div>
					<p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-sm">
						<span>{t("globals.intro")}</span>
						{globals.updatedAt ? (
							<>
								<span aria-hidden="true">·</span>
								<SaveStatusText status={autosave.status} savedAt={globals.updatedAt} />
							</>
						) : null}
					</p>
				</div>

				<LanguageTabs
					languages={languages}
					current={globals.language}
					link={(language) => ({
						to: "/sites/$siteId/globals",
						params: { siteId },
						search: { language: language === languages.default ? undefined : language },
					})}
				/>

				{saveError ? <SaveErrorBanner error={saveError} onRetry={() => void autosave.flush()} /> : null}

				{globals.fields.length === 0 ? (
					<div className="text-muted-foreground grid gap-2 rounded-lg border border-dashed p-8 text-center">
						<p>{t("globals.empty")}</p>
						{permissions.includes("structure.edit") ? (
							<p>
								<Link
									to="/sites/$siteId/post-types/globals"
									params={{ siteId }}
									className="text-foreground focus-visible:ring-ring/50 rounded-sm underline underline-offset-4 outline-none focus-visible:ring-3"
								>
									{t("globals.defineFields")}
								</Link>
							</p>
						) : null}
					</div>
				) : (
					<FieldValueList
						fields={globals.fields}
						values={values}
						onChange={(key, value) => {
							setValues((before) => ({ ...before, [key]: value }));
							autosave.change({ [key]: value });
						}}
						context={context}
					/>
				)}
			</div>

			<div className="grid content-start gap-6">
				<DraftStatusCard
					status={globals.status}
					lastPublishedAt={globals.lastPublishedAt}
					autosave={autosave}
					canPublish={canPublish}
					publishDisabled={globals.fields.length === 0}
					publishing={publishing}
					publishHelp="globals.publishHelp"
					problems={problems}
					fields={globals.fields}
					idPrefix="globals"
					headingId="globals-problems-heading"
				/>
			</div>
		</div>
	);
}
