import { useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { useAutosave } from "../content/autosave.ts";
import {
	DraftStatusCard,
	LanguageTabs,
	SaveErrorBanner,
	SaveStatusText,
	StatusBadge,
	useDraftPublish,
} from "../content/DraftParts.tsx";
import { FieldValueList, type ValueContext } from "../content/FieldValues.tsx";
import type { FieldDefinition, FieldValues, Json, Problem } from "../content/model.ts";
import { errorCode, errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { ReviewStatus, SubmitForReview } from "../review/Review.tsx";

/** A Site's Consent banner as `consentBanner.get` answers it. */
export type ConsentBannerView = Awaited<ReturnType<ApiClient["consentBanner"]["get"]>>["banner"];

/** The words people write, by key, as their labels are named in the messages (the list's name is WebCraft's own). */
type WordKey = Exclude<keyof ConsentBannerView["text"]["defaults"], "categories">;

/**
 * The Consent banner's words (Content): what it says in each language, saved to its Draft as people
 * type and put live when published, like the Globals. A word left empty shows WebCraft's own, which
 * each one's help says.
 */
export function ConsentBannerWords({
	siteId,
	banner: loaded,
	permissions,
	languages,
}: {
	siteId: string;
	banner: ConsentBannerView;
	permissions: readonly string[];
	languages: { default: string; all: readonly string[] };
}) {
	const t = useT();
	const router = useRouter();
	const [text, setText] = useState(loaded.text);
	const [values, setValues] = useState(() => loaded.text.draft as FieldValues);
	const [refused, setRefused] = useState<Problem[]>([]);
	const [saveError, setSaveError] = useState<MessageKey | null>(null);
	const canPublish = permissions.includes("entry.publish");

	const autosave = useAutosave<Record<string, Json>>({
		merge: (older, newer) => ({ ...older, ...newer }),
		save: async (fields) => {
			const api = await getApi();
			const { banner } = await api.consentBanner.saveDraft({ siteId, language: text.language, fields });
			setText(banner.text);
			setRefused([]);
			setSaveError(null);
		},
		onFailed: (error) => {
			const data = (error as { data?: { problems?: Problem[] } }).data;
			if (errorCode(error) === "CONSENT_BANNER_INVALID" && data?.problems) setRefused(data.problems);
			setSaveError(errorMessage(error));
		},
	});

	/** Reads the words again: their status and Review. */
	const refresh = async () => {
		const api = await getApi();
		const { banner } = await api.consentBanner.get({ siteId, language: text.language });
		setText(banner.text);
	};

	const publishing = useDraftPublish({
		flush: autosave.flush,
		invalid: ["CONSENT_BANNER_INVALID"],
		publish: async () => {
			const api = await getApi();
			const { banner } = await api.consentBanner.publish({ siteId });
			setText(banner.text);
			toast.success(t("consentBanner.published"));
			await router.invalidate();
		},
	});

	// Each word is labelled in the person's language, and says what shows while it is empty.
	const defaults = text.defaults as Record<string, string>;
	const fields = (text.fields as readonly FieldDefinition[]).map((field) => ({
		...field,
		label: t(`consentBanner.fields.${field.key as WordKey}`),
		help:
			field.key === "privacyPolicy"
				? t("consentBanner.privacyHelp", { text: defaults.privacyPolicy ?? "" })
				: t("consentBanner.default", { text: defaults[field.key] ?? "" }),
	})) as FieldDefinition[];
	const problems = [...text.problems, ...refused];
	const context: ValueContext = {
		siteId,
		idPrefix: "consent",
		language: text.language,
		defaultLanguage: languages.default,
		problems,
		relationships: {},
		media: {},
		onMediaChosen: () => {},
		markShared: true,
	};

	return (
		<section aria-labelledby="consent-words-heading" className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_20rem]">
			<div className="grid min-w-0 content-start gap-6">
				<div className="grid gap-1">
					<div className="flex flex-wrap items-center gap-3">
						<h2 id="consent-words-heading" className="text-xl font-semibold tracking-tight">
							{t("consentBanner.wordsTitle")}
						</h2>
						<StatusBadge status={text.status} />
					</div>
					<p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-sm">
						<span>{t("consentBanner.wordsIntro")}</span>
						{text.updatedAt ? (
							<>
								<span aria-hidden="true">·</span>
								<SaveStatusText status={autosave.status} savedAt={text.updatedAt} />
							</>
						) : null}
					</p>
					{loaded.mode === "outside" || loaded.mode === "none" ? (
						<p className="text-muted-foreground text-sm">
							{t(loaded.mode === "outside" ? "consentBanner.wordsOutside" : "consentBanner.wordsNone")}
						</p>
					) : null}
				</div>

				<LanguageTabs
					languages={languages}
					current={text.language}
					link={(language) => ({
						to: "/sites/$siteId/consent-banner",
						params: { siteId },
						search: { language: language === languages.default ? undefined : language },
					})}
				/>

				{saveError ? <SaveErrorBanner error={saveError} onRetry={() => void autosave.flush()} /> : null}

				<FieldValueList
					fields={fields}
					values={values}
					onChange={(key, value) => {
						setValues((before) => ({ ...before, [key]: value }));
						autosave.change({ [key]: value });
					}}
					context={context}
				/>
			</div>

			<div className="grid content-start gap-6">
				<DraftStatusCard
					status={text.status}
					lastPublishedAt={text.lastPublishedAt}
					autosave={autosave}
					canPublish={canPublish}
					publishing={publishing}
					publishHelp="consentBanner.publishHelp"
					problems={problems}
					fields={fields}
					idPrefix="consent"
					headingId="consent-problems-heading"
					submit={
						<SubmitForReview
							siteId={siteId}
							items={[{ kind: "consentBanner" }]}
							disabled={text.status === "published" || text.review?.status === "inReview"}
							flush={autosave.flush}
							onSubmitted={refresh}
							onProblems={() => publishing.summary.current?.focus()}
						/>
					}
					authorHelp={text.review?.status === "inReview" ? "review.inReviewHelp" : "review.authorHelp"}
					review={<ReviewStatus siteId={siteId} review={text.review} onChanged={refresh} />}
				/>
			</div>
		</section>
	);
}
