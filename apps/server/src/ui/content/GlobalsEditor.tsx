import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { useCoEditedValues } from "../co-editing/co-edited.ts";
import {
	PresenceList,
	PresenceOutline,
	SharedDraftBanner,
	SharedDraftStatus,
	usePlaceTracking,
} from "../co-editing/Presence.tsx";
import { documentValues, readFieldValues, withFieldValues } from "../co-editing/values.ts";
import { errorMessage } from "../errors.ts";
import { HistoryCard } from "../history/HistoryCard.tsx";
import type { HistoryPage } from "../history/model.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import type { MediaItem } from "../media/preview.ts";
import { ReviewStatus, SubmitForReview } from "../review/Review.tsx";
import { SettingsCard } from "../settings/layout.tsx";
import { PageHeader } from "../shell/page.tsx";
import { DraftStatusCard, LanguageTabs, SaveErrorBanner, StatusBadge, useDraftPublish } from "./DraftParts.tsx";
import { FieldValueList, type ValueContext } from "./FieldValues.tsx";
import {
	type FieldDefinition,
	type FieldValues,
	type GlobalsView,
	groupValues,
	type Json,
	type Problem,
} from "./model.ts";

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
	history,
}: {
	siteId: string;
	globals: GlobalsView;
	permissions: readonly string[];
	languages: { default: string; all: readonly string[] };
	media: Readonly<Record<string, MediaItem>>;
	/** The newest of the Globals' Revisions and Checkpoints. */
	history: HistoryPage;
}) {
	const t = useT();
	const router = useRouter();
	const [globals, setGlobals] = useState(loaded);
	const [refused, setRefused] = useState<Problem[]>([]);
	const [saveError, setSaveError] = useState<MessageKey | null>(null);
	const [media, setMedia] = useState(knownMedia);
	const canPublish = permissions.includes("entry.publish");
	const valueLanguages = { language: globals.language, defaultLanguage: languages.default };

	// The Draft is shared (Co-editing): everyone editing it sees each other's changes as they are saved.
	const coEdited = useCoEditedValues<FieldValues, Record<string, Json>>({
		path: `/api/drafts/${siteId}/globals`,
		initial: loaded.draft as FieldValues,
		read: (draft) => readFieldValues(documentValues(draft), globals.fields, valueLanguages),
		write: (draft, fields) => withFieldValues(draft, fields, globals.fields, valueLanguages),
		merge: (before, fields) => ({ ...before, ...fields }),
		onRefused: (refusal) => {
			const data = refusal.data as { problems?: Problem[] } | undefined;
			if (refusal.code === "GLOBALS_INVALID" && data?.problems) setRefused(data.problems);
			setSaveError(errorMessage(refusal));
		},
		onSettled: async () => {
			const api = await getApi();
			const { globals: fresh } = await api.globals.get({ siteId, language: globals.language });
			setGlobals(fresh);
		},
	});
	const { shared, values, autosave, locked } = coEdited;
	const tracking = usePlaceTracking(shared.place);

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

	const change = (part: Record<string, Json>) => {
		setRefused([]);
		setSaveError(null);
		coEdited.change(part);
	};

	/** Reads the Globals again: their status and Review. */
	const refresh = async () => {
		const api = await getApi();
		const { globals: fresh } = await api.globals.get({ siteId, language: globals.language });
		setGlobals(fresh);
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
		<div className="grid gap-8 @4xl/page:grid-cols-[minmax(0,45rem)_20rem]">
			<div className="grid min-w-0 content-start gap-6">
				{/* The column's gap already parts the header from the tabs. */}
				<div className="[&>div]:mb-0">
					<PageHeader heading={t("globals.heading")} badge={<StatusBadge status={globals.status} />}>
						<span className="flex flex-wrap items-center gap-x-2">
							<span>{t("globals.intro")}</span>
							<span aria-hidden="true">·</span>
							<SharedDraftStatus status={shared.status} editable={shared.editable} publishedBy={coEdited.publishedBy} />
						</span>
					</PageHeader>
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

				<PresenceList participants={shared.participants} />

				<SharedDraftBanner status={shared.status} editable={shared.editable} />

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
					<fieldset disabled={locked} className="grid min-w-0 gap-6" {...tracking}>
						{cardsOf(globals.fields).map((card) =>
							card.group ? (
								<PresenceOutline key={card.group.key} place={card.group.key} participants={shared.participants}>
									<SettingsCard title={card.group.label} description={card.group.help ?? undefined}>
										<FieldValueList
											fields={card.group.fields}
											values={groupValues(values[card.group.key] ?? null)}
											at={`fields.${card.group.key}.`}
											onChange={(key, value) => {
												const group = card.group?.key ?? "";
												change({ [group]: { ...groupValues(values[group] ?? null), [key]: value } });
											}}
											context={context}
										/>
									</SettingsCard>
								</PresenceOutline>
							) : (
								<SettingsCard key={card.fields[0]?.key ?? "values"} title={t("globals.valuesHeading")}>
									<FieldValueList
										fields={card.fields}
										values={values}
										onChange={(key, value) => change({ [key]: value })}
										context={context}
										wrap={(field, control) => (
											<PresenceOutline place={field.key} participants={shared.participants}>
												{control}
											</PresenceOutline>
										)}
									/>
								</SettingsCard>
							),
						)}
					</fieldset>
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
					submit={
						<SubmitForReview
							siteId={siteId}
							items={[{ kind: "globals" }]}
							disabled={
								locked ||
								globals.fields.length === 0 ||
								globals.status === "published" ||
								globals.review?.status === "inReview"
							}
							flush={autosave.flush}
							onSubmitted={refresh}
							onProblems={() => publishing.summary.current?.focus()}
						/>
					}
					authorHelp={globals.review?.status === "inReview" ? "review.inReviewHelp" : "review.authorHelp"}
					review={<ReviewStatus siteId={siteId} review={globals.review} onChanged={refresh} />}
				/>
				<HistoryCard siteId={siteId} item={{ kind: "globals" }} history={history} />
			</div>
		</div>
	);
}

type GroupField = Extract<FieldDefinition, { type: "group" }>;

/**
 * The Globals' cards, as a settings screen has them: each Group of Fields on a card of its own, named
 * by it, and the Fields between Groups together on a card.
 */
function cardsOf(fields: readonly FieldDefinition[]): { group: GroupField | null; fields: FieldDefinition[] }[] {
	const cards: { group: GroupField | null; fields: FieldDefinition[] }[] = [];
	for (const field of fields) {
		if (field.type === "group") cards.push({ group: field, fields: [] });
		else if (cards.at(-1)?.group === null) cards.at(-1)?.fields.push(field);
		else cards.push({ group: null, fields: [field] });
	}
	return cards;
}
