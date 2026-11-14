import type { BuildingAreaApiClient } from "@webcraft/api";
import { Trash2Icon } from "lucide-react";
import { useId, useState } from "react";

import { fill, type Words } from "../../../api.ts";
import { FOCUS_RING } from "../../../controls.tsx";
import type { PostTypeRow } from "../../../management.ts";
import { Card, codeOf, Locked, problemsOf, problemText, reasonText, Switch, TextSetting } from "./controls.tsx";
import { dangerLook } from "./DeleteDialog.tsx";

/** What the Settings tab changes. */
type Change = { name?: string; urlPattern?: string; searchable?: boolean; sitemap?: boolean; revisions?: boolean };

/**
 * A Post Type's Settings tab in the Content place (SPEC 8): its name, its key (locked: Templates,
 * Loops and files name it), its URL pattern (locked for Pages, found by parent Page and slug), and
 * whether Site search shows its Entries, the sitemaps list them and publishing saves Revisions; the
 * Searched fields and SEO settings stay in the admin, which it links to. Each change applies at once
 * (`postTypes.update`; Structure has no Draft). Delete Post Type opens the dialog the list opens.
 */
export function SettingsTab({
	words,
	api,
	siteId,
	postType,
	admin,
	onSaved,
	onSaving,
	onDelete,
	announce,
}: {
	words: Words;
	api: BuildingAreaApiClient;
	siteId: string;
	postType: PostTypeRow;
	/** This Post Type in the admin. */
	admin: string;
	onSaved(postType: PostTypeRow): void;
	onSaving(status: "saving" | "saved" | "failed"): void;
	onDelete(): void;
	announce(text: string, urgent?: boolean): void;
}) {
	const shown = words.postTypes.settings;
	const fieldWords = words.postTypes.fields;
	const pages = postType.builtIn === "page";
	const [problems, setProblems] = useState<ReadonlyMap<string, string>>(new Map());
	const id = useId();

	const save = async (change: Change, setting: string) => {
		onSaving("saving");
		try {
			const { postType: saved } = await api.postTypes.update({ siteId, postTypeId: postType.id, ...change });
			onSaved(saved as PostTypeRow);
			onSaving("saved");
			setProblems(new Map());
		} catch (error) {
			onSaving("failed");
			const found = new Map<string, string>();
			for (const problem of problemsOf(error)) found.set(problem.at, problemText(words, problem));
			const code = codeOf(error);
			if (found.size === 0 && (code === "POST_TYPE_TAKEN" || code === "PATH_TAKEN"))
				found.set("urlPattern", reasonText(words, error));
			setProblems(found);
			announce(fill(shown.saveFailed, { setting, reason: reasonText(words, error) }), true);
		}
	};

	const toggle = (key: "searchable" | "sitemap" | "revisions", label: string) => (
		<Card label={label} htmlFor={`${id}-${key}`}>
			<Switch
				id={`${id}-${key}`}
				checked={postType[key]}
				words={fieldWords}
				onChange={(checked) => void save({ [key]: checked }, label)}
			/>
		</Card>
	);

	return (
		<section
			aria-labelledby={`${id}-heading`}
			className="flex max-w-[480px] flex-col gap-2.5 p-4"
			data-wc-post-type-settings={postType.key}
		>
			<h3 id={`${id}-heading`} className="sr-only">
				{fill(shown.heading, { name: postType.name })}
			</h3>
			<Card label={shown.name} htmlFor={`${id}-name`} problem={problems.get("name") ?? null}>
				<TextSetting
					id={`${id}-name`}
					value={postType.name}
					maxLength={200}
					invalid={problems.has("name")}
					onSave={(text) => void save({ name: text }, shown.name)}
					data={{ "data-wc-post-type-setting": "name" }}
				/>
			</Card>
			<Card label={shown.key}>
				<Locked value={postType.key} why={shown.keyLocked} mono />
			</Card>
			<Card
				label={shown.urlPattern}
				htmlFor={pages ? undefined : `${id}-pattern`}
				problem={problems.get("urlPattern") ?? null}
				help={pages ? undefined : shown.urlPatternHelp}
				helpId={`${id}-pattern-help`}
			>
				{pages ? (
					<Locked value={postType.urlPattern} why={shown.urlPatternPages} mono />
				) : (
					<TextSetting
						id={`${id}-pattern`}
						value={postType.urlPattern}
						mono
						maxLength={500}
						describedBy={`${id}-pattern-help`}
						invalid={problems.has("urlPattern")}
						onSave={(text) => void save({ urlPattern: text }, shown.urlPattern)}
						data={{ "data-wc-post-type-setting": "urlPattern" }}
					/>
				)}
			</Card>
			{toggle("searchable", shown.searchable)}
			{toggle("sitemap", shown.sitemap)}
			{toggle("revisions", shown.revisions)}
			<a
				href={admin}
				target="_blank"
				rel="noopener noreferrer"
				className={`text-chrome-accent self-start rounded-sm text-[12px] font-medium underline-offset-2 hover:underline ${FOCUS_RING}`}
			>
				{shown.more}
			</a>
			{pages ? null : (
				<div className="pt-4">
					<button
						type="button"
						onClick={onDelete}
						className={`${dangerLook} w-full`}
						data-wc-post-type-settings-delete=""
					>
						<Trash2Icon aria-hidden="true" className="size-3.5" />
						{shown.deletePostType}
					</button>
				</div>
			)}
		</section>
	);
}
