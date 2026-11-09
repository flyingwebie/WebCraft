import { Link, useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@webcraft/ui/components/card.tsx";
import { CircleAlertIcon, UploadIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorCode, errorMessage } from "../errors.ts";
import { formatUtc } from "../format.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import type { MediaItem } from "../media/preview.ts";
import { useAutosave } from "./autosave.ts";
import { LanguageTabs, ProblemSummary, SaveStatusText, StatusBadge } from "./DraftParts.tsx";
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
	const [publishError, setPublishError] = useState<string | null>(null);
	const [publishing, setPublishing] = useState(false);
	const [media, setMedia] = useState(knownMedia);
	const summary = useRef<HTMLDivElement>(null);
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

	const publish = async () => {
		setPublishing(true);
		setPublishError(null);
		try {
			if (!(await autosave.flush())) {
				setPublishError(t("entries.editor.saveFirst"));
				return;
			}
			const api = await getApi();
			const { globals: published } = await api.globals.publish({ siteId });
			setGlobals(published);
			toast.success(t("globals.published"));
			await router.invalidate();
		} catch (error) {
			const code = errorCode(error);
			if (code === "GLOBALS_INVALID" || code === "GLOBALS_INCOMPLETE") {
				setPublishError(t("entries.editor.fixFirst"));
				requestAnimationFrame(() => summary.current?.focus());
			} else {
				setPublishError(t(errorMessage(error)));
			}
		} finally {
			setPublishing(false);
		}
	};

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

				{saveError ? (
					<div
						role="alert"
						className="border-destructive/50 text-destructive flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"
					>
						<CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
						<span className="flex-1">{t(saveError)}</span>
						<Button type="button" size="sm" variant="outline" onClick={() => void autosave.flush()}>
							{t("entries.editor.retry")}
						</Button>
					</div>
				) : null}

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
				<Card>
					<CardHeader>
						<CardTitle>
							<h2>{t("entries.editor.statusHeading")}</h2>
						</CardTitle>
					</CardHeader>
					<CardContent className="grid gap-4">
						<div className="flex flex-wrap items-center justify-between gap-2 text-sm">
							<StatusBadge status={globals.status} />
							{globals.lastPublishedAt ? (
								<span className="text-muted-foreground">
									{t("entries.editor.liveSince", { date: formatUtc(globals.lastPublishedAt) })}
								</span>
							) : null}
						</div>
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								variant="outline"
								disabled={autosave.status === "saved"}
								onClick={() => void autosave.flush()}
							>
								{t("entries.editor.saveDraft")}
							</Button>
							{canPublish ? (
								<Button type="button" disabled={publishing || globals.fields.length === 0} onClick={publish}>
									<UploadIcon aria-hidden="true" />
									{t("entries.editor.publish")}
								</Button>
							) : null}
						</div>
						<p className="text-muted-foreground text-sm">
							{t(canPublish ? "globals.publishHelp" : "entries.editor.authorHelp")}
						</p>
						{publishError ? (
							<p role="alert" className="text-destructive flex items-start gap-2 text-sm">
								<CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
								{publishError}
							</p>
						) : null}
						<div ref={summary} tabIndex={-1} className="outline-none">
							<ProblemSummary
								problems={problems}
								fields={globals.fields}
								idPrefix="globals"
								headingId="globals-problems-heading"
							/>
						</div>
					</CardContent>
				</Card>
			</div>
		</div>
	);
}
