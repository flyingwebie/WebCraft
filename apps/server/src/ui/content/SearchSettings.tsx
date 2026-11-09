import { useRouter } from "@tanstack/react-router";
import { SEARCH_WEIGHTS, SEARCHED_TYPES, type SearchWeight } from "@webcraft/core/search-fields";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { CircleAlertIcon } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorCode, errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import type { FieldDefinition, PostTypeView, Problem } from "./model.ts";
import { settingProblemText } from "./problems.ts";

/** One Field Site search can read, by its path (`origin.city`), named as Staff see it ("Origin › City"). */
type Searchable = { path: string; name: string };

/** The Fields of a Post Type search reads as text, in order: Groups' and Repeaters' Fields under their names. */
function searchableFields(fields: readonly FieldDefinition[], prefix = "", names: string[] = []): Searchable[] {
	return fields.flatMap((field) => {
		const path = `${prefix}${field.key}`;
		const name = [...names, field.label || field.key];
		if (field.type === "group" || field.type === "repeater") {
			return searchableFields(field.fields, `${path}.`, name);
		}
		return SEARCHED_TYPES.has(field.type) ? [{ path, name: name.join(" › ") }] : [];
	});
}

/**
 * A Post Type's Site search settings (Structure, ADR 0021): whether Site search lists its Entries,
 * and its Searched fields with their weights, A (counts most) to D. Like the rest of a Post Type,
 * changes apply once saved; the server then rebuilds the Site's search index in the background.
 */
export function SearchSettings({ postType, siteId }: { postType: PostTypeView; siteId: string }) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const titleName = t("content.builtIn.title");
	const rows = useMemo<Searchable[]>(
		() => [{ path: "title", name: titleName }, ...searchableFields(postType.fields)],
		[postType.fields, titleName],
	);
	const initial = useMemo(
		() => ({
			searchable: postType.searchable,
			weights: Object.fromEntries(postType.searchedFields.map((item) => [item.field, item.weight])) as Record<
				string,
				SearchWeight
			>,
		}),
		[postType],
	);
	const [searchable, setSearchable] = useState(initial.searchable);
	// Each row's weight is kept while it isn't searched, so ticking it again brings the weight back.
	const [weights, setWeights] = useState<Record<string, SearchWeight>>(() => ({ ...initial.weights }));
	const [searched, setSearched] = useState<ReadonlySet<string>>(() => new Set(Object.keys(initial.weights)));
	const [baseline, setBaseline] = useState(() => JSON.stringify(state(initial.searchable, rows, initial.weights)));
	const [problems, setProblems] = useState<string[] | null>(null);
	const [busy, setBusy] = useState(false);
	const summary = useRef<HTMLDivElement>(null);

	const current = state(
		searchable,
		rows,
		Object.fromEntries(rows.filter((row) => searched.has(row.path)).map((row) => [row.path, weights[row.path] ?? "B"])),
	);
	const dirty = JSON.stringify(current) !== baseline;

	const toggle = (path: string, on: boolean) =>
		setSearched((before) => {
			const next = new Set(before);
			if (on) next.add(path);
			else next.delete(path);
			return next;
		});

	const discard = () => {
		setSearchable(initial.searchable);
		setWeights({ ...initial.weights });
		setSearched(new Set(Object.keys(initial.weights)));
		setProblems(null);
	};

	const save = async () => {
		setBusy(true);
		setProblems(null);
		try {
			const api = await getApi();
			const { postType: saved } = await api.postTypes.update({
				siteId,
				postTypeId: postType.id,
				searchable: current.searchable,
				searchedFields: current.searchedFields,
			});
			setBaseline(
				JSON.stringify(
					state(
						saved.searchable,
						rows,
						Object.fromEntries(saved.searchedFields.map((item) => [item.field, item.weight])),
					),
				),
			);
			toast.success(t("postTypes.search.saved"));
			await router.invalidate();
		} catch (error) {
			const data = (error as { data?: { problems?: Problem[] } }).data;
			setProblems(
				errorCode(error) === "POST_TYPE_INVALID" && data?.problems
					? data.problems.map((problem) => settingProblemText(t, problem))
					: [t(errorMessage(error))],
			);
			requestAnimationFrame(() => summary.current?.focus());
		} finally {
			setBusy(false);
		}
	};

	return (
		<section aria-labelledby={`${id}-heading`} className="grid min-w-0 content-start gap-6">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="grid max-w-prose gap-1">
					<h2 id={`${id}-heading`} className="text-lg font-semibold">
						{t("postTypes.search.heading")}
					</h2>
					<p className="text-muted-foreground">{t("postTypes.search.intro")}</p>
				</div>
				<div className="flex items-center gap-3">
					<p role="status" className="text-muted-foreground text-sm">
						{dirty ? t("postTypes.search.unsaved") : ""}
					</p>
					<Button type="button" variant="outline" disabled={!dirty || busy} onClick={discard}>
						{t("postTypes.search.discard")}
					</Button>
					<Button type="button" disabled={!dirty || busy} onClick={save}>
						{t("postTypes.search.save")}
					</Button>
				</div>
			</div>

			{problems ? (
				<div
					ref={summary}
					tabIndex={-1}
					role="alert"
					className="border-destructive/50 text-destructive grid gap-2 rounded-lg border p-4 text-sm outline-none"
				>
					<p className="flex items-center gap-2 font-medium">
						<CircleAlertIcon className="size-4" aria-hidden="true" />
						{t("postTypes.search.notSaved")}
					</p>
					<ul className="grid list-disc gap-1 ps-6">
						{problems.map((problem) => (
							<li key={problem}>{problem}</li>
						))}
					</ul>
				</div>
			) : null}

			<div className="flex items-start gap-2">
				<Checkbox
					id={`${id}-searchable`}
					checked={searchable}
					onCheckedChange={(value) => setSearchable(value === true)}
					aria-describedby={`${id}-searchable-help`}
					className="mt-0.5"
				/>
				<div className="grid gap-0.5">
					<Label htmlFor={`${id}-searchable`}>{t("postTypes.search.searchable")}</Label>
					<p id={`${id}-searchable-help`} className="text-muted-foreground text-sm">
						{t("postTypes.search.searchableHelp")}
					</p>
				</div>
			</div>

			<div className="grid gap-3">
				<div className="grid max-w-prose gap-1">
					<h3 className="font-medium">{t("postTypes.search.fieldsHeading")}</h3>
					<p className="text-muted-foreground text-sm">{t("postTypes.search.fieldsHelp")}</p>
				</div>
				<div className="overflow-x-auto rounded-lg border">
					<table className="w-full text-sm">
						<thead className="text-muted-foreground text-start">
							<tr className="border-b">
								<th scope="col" className="px-4 py-2 text-start font-medium">
									{t("postTypes.search.field")}
								</th>
								<th scope="col" className="px-4 py-2 text-start font-medium">
									{t("postTypes.search.searched")}
								</th>
								<th scope="col" className="px-4 py-2 text-start font-medium">
									{t("postTypes.search.weight")}
								</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row, index) => {
								const on = searched.has(row.path);
								const rowId = `${id}-row-${index}`;
								return (
									<tr key={row.path} className="border-b last:border-b-0">
										<th scope="row" className="px-4 py-2 text-start font-normal">
											<span className="grid">
												<span>{row.name}</span>
												<code className="text-muted-foreground text-xs">{row.path}</code>
											</span>
										</th>
										<td className="px-4 py-2">
											<Checkbox
												id={`${rowId}-searched`}
												checked={on}
												onCheckedChange={(value) => toggle(row.path, value === true)}
												aria-label={t("postTypes.search.searchField", { field: row.name })}
											/>
										</td>
										<td className="px-4 py-2">
											<NativeSelect
												id={`${rowId}-weight`}
												aria-label={t("postTypes.search.weightOf", { field: row.name })}
												disabled={!on}
												value={weights[row.path] ?? "B"}
												onChange={(event) =>
													setWeights((before) => ({ ...before, [row.path]: event.target.value as SearchWeight }))
												}
											>
												{SEARCH_WEIGHTS.map((weight) => (
													<NativeSelectOption key={weight} value={weight}>
														{t(`postTypes.search.weights.${weight}`)}
													</NativeSelectOption>
												))}
											</NativeSelect>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
				{rows.length === 1 ? <p className="text-muted-foreground text-sm">{t("postTypes.search.none")}</p> : null}
			</div>
		</section>
	);
}

/** What the tab saves: whether Site search lists the Post Type, and its Searched fields in the rows' order. */
function state(searchable: boolean, rows: readonly Searchable[], weights: Readonly<Record<string, SearchWeight>>) {
	return {
		searchable,
		searchedFields: rows.flatMap((row) => {
			const weight = weights[row.path];
			return weight ? [{ field: row.path, weight }] : [];
		}),
	};
}
