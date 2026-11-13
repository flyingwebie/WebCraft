import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { ArrowRightIcon, CircleAlertIcon, ListChecksIcon, LoaderIcon, TableIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { getApi } from "../api.ts";
import { languageName } from "../content/DraftParts.tsx";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import {
	type ColumnTarget,
	type CsvFileView,
	type CsvSettings,
	type PreviewView,
	problemWording,
	settingWording,
} from "./model.ts";

/** A CSV file's details on one line: rows, columns, separator and encoding, with its name above. */
export function CsvFileCard({ file, action }: { file: CsvFileView; action?: React.ReactNode }) {
	const t = useT();
	return (
		<div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
			<span className="bg-muted rounded-md p-2">
				<TableIcon className="size-4" aria-hidden="true" />
			</span>
			<div className="grid min-w-0 flex-1">
				<span className="truncate font-medium">{file.fileName}</span>
				<span className="text-muted-foreground text-sm">
					{t("imports.file.details", {
						rows: file.rows,
						columns: file.columns.length,
						separator: t(`imports.file.separators.${file.separator}`),
					})}
				</span>
			</div>
			{action}
		</div>
	);
}

/**
 * Where each column of a CSV file goes (a Field, the title, the slug, or Skip), with the first row's
 * value beside it; what rows match existing Entries by; and, on a Site with several languages, the
 * language values are written in.
 */
export function CsvMappingEditor({
	file,
	targets,
	settings,
	onChange,
	languages,
	headingLevel = 3,
}: {
	file: CsvFileView;
	targets: readonly ColumnTarget[];
	settings: CsvSettings;
	onChange(next: CsvSettings): void;
	languages: { default: string; all: readonly string[] };
	/** The level of the Columns heading, under the screen's or the sheet's own heading. */
	headingLevel?: 2 | 3;
}) {
	const Heading = headingLevel === 2 ? "h2" : "h3";
	const t = useT();
	const ids = useId();
	const mapped = new Map(settings.columns.map((column) => [column.column, column.to]));
	const taken = new Set(settings.columns.flatMap((column) => (column.to ? [column.to] : [])));
	const matchable = targets.filter((target) => target.matchable);
	const setColumn = (column: string, to: string | null) =>
		onChange({
			...settings,
			columns: file.columns.map(({ name }) => ({
				column: name,
				to: name === column ? to : (mapped.get(name) ?? null),
			})),
		});
	return (
		<div className="grid gap-6">
			{languages.all.length > 1 ? (
				<Field>
					<FieldLabel htmlFor={`${ids}-language`}>{t("imports.map.language")}</FieldLabel>
					<NativeSelect
						id={`${ids}-language`}
						className="w-full"
						value={settings.language ?? ""}
						aria-describedby={`${ids}-language-help`}
						onChange={(event) => onChange({ ...settings, language: event.target.value || null })}
					>
						<NativeSelectOption value="">
							{t("imports.map.defaultLanguage", { language: languageName(languages.default) })}
						</NativeSelectOption>
						{languages.all
							.filter((language) => language !== languages.default)
							.map((language) => (
								<NativeSelectOption key={language} value={language}>
									{languageName(language)}
								</NativeSelectOption>
							))}
					</NativeSelect>
					<FieldDescription id={`${ids}-language-help`}>{t("imports.map.languageHelp")}</FieldDescription>
				</Field>
			) : null}
			<Field>
				<FieldLabel htmlFor={`${ids}-match`}>{t("imports.map.matchBy")}</FieldLabel>
				<NativeSelect
					id={`${ids}-match`}
					className="w-full"
					value={settings.match}
					aria-describedby={`${ids}-match-help`}
					onChange={(event) => onChange({ ...settings, match: event.target.value })}
				>
					{matchable.map((target) => (
						<NativeSelectOption key={target.to} value={target.to}>
							{target.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<FieldDescription id={`${ids}-match-help`}>
					{taken.has(settings.match) ? t("imports.map.matchHelp") : t("imports.map.matchNotMapped")}
				</FieldDescription>
			</Field>
			<div className="grid gap-2">
				<Heading className="font-medium" id={`${ids}-columns`}>
					{t("imports.map.columns")}
				</Heading>
				<div className="rounded-lg border">
					<Table aria-labelledby={`${ids}-columns`}>
						<TableHeader>
							<TableRow>
								<TableHead className="ps-4">{t("imports.map.column")}</TableHead>
								<TableHead>{t("imports.map.field")}</TableHead>
								<TableHead className="pe-4">{t("imports.map.firstRow")}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{file.columns.map((column, index) => {
								const to = mapped.get(column.name) ?? null;
								const selectId = `${ids}-column-${index}`;
								return (
									<TableRow key={column.name}>
										<TableCell className="ps-4">
											<span className="flex items-center gap-2">
												<code className="bg-muted rounded px-1.5 py-0.5 text-xs">{column.name}</code>
												<ArrowRightIcon className="text-muted-foreground size-4 rtl:rotate-180" aria-hidden="true" />
											</span>
										</TableCell>
										<TableCell>
											<label htmlFor={selectId} className="sr-only">
												{t("imports.map.fieldFor", { column: column.name })}
											</label>
											<NativeSelect
												id={selectId}
												className="w-full min-w-40"
												value={to ?? ""}
												onChange={(event) => setColumn(column.name, event.target.value || null)}
											>
												<NativeSelectOption value="">{t("imports.map.skip")}</NativeSelectOption>
												{targets.map((target) => (
													<NativeSelectOption
														key={target.to}
														value={target.to}
														disabled={taken.has(target.to) && target.to !== to}
													>
														{target.label}
													</NativeSelectOption>
												))}
											</NativeSelect>
										</TableCell>
										<TableCell className="text-muted-foreground max-w-48 truncate pe-4" title={column.first}>
											{column.first || "—"}
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</div>
			</div>
		</div>
	);
}

/** Keeps a preview of what a run would do with a file and these settings, asked again a moment after they change. */
export function usePreview(siteId: string, fileId: string | null, settings: CsvSettings | null, importId?: string) {
	const [state, setState] = useState<{ preview: PreviewView | null; error: unknown; loading: boolean }>({
		preview: null,
		error: null,
		loading: false,
	});
	const key = JSON.stringify([fileId, settings, importId]);
	const latest = useRef(key);
	useEffect(() => {
		latest.current = key;
		if (!fileId || !settings) return;
		setState((before) => ({ ...before, loading: true }));
		const timer = setTimeout(async () => {
			try {
				const api = await getApi();
				const { preview } = await api.imports.preview({ siteId, fileId, settings, importId: importId ?? null });
				if (latest.current === key) setState({ preview, error: null, loading: false });
			} catch (error) {
				if (latest.current === key) setState({ preview: null, error, loading: false });
			}
		}, 300);
		return () => clearTimeout(timer);
	}, [key, siteId, fileId, settings, importId]);
	return state;
}

/** Problems the server found in the settings (`IMPORT_INVALID`), each worded. */
function settingProblems(error: unknown): MessageKey[] {
	const { code, data } = (error ?? {}) as { code?: unknown; data?: { problems?: { rule: string }[] } };
	if (code !== "IMPORT_INVALID") return [];
	return [...new Set((data?.problems ?? []).map((problem) => settingWording(problem.rule)))];
}

/**
 * What a run would do: Drafts it creates and updates, rows it skips, files it fetches and problem
 * rows; "See rows" lists the problems by row and column. Announced politely as it changes.
 */
export function PreviewSummary({
	preview,
	error,
	loading,
}: {
	preview: PreviewView | null;
	error: unknown;
	loading: boolean;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const listId = useId();
	const settings = settingProblems(error);
	return (
		<div className="bg-muted/50 grid gap-3 rounded-lg border p-4" aria-live="polite" aria-busy={loading}>
			{error ? (
				<div className="text-destructive flex gap-2 text-sm">
					<CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					<ul className="grid gap-1">
						{(settings.length > 0 ? settings : [errorMessage(error)]).map((key) => (
							<li key={key}>{t(key)}</li>
						))}
					</ul>
				</div>
			) : preview ? (
				<>
					<div className="flex flex-wrap items-center gap-3">
						{loading ? (
							<LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
						) : (
							<ListChecksIcon className="size-4" aria-hidden="true" />
						)}
						<p className="flex-1 text-sm">
							{t("imports.preview.summary", {
								create: preview.counts.create,
								update: preview.counts.update,
								skip: preview.counts.skip,
							})}
							{preview.counts.problemRows > 0
								? ` · ${t("imports.preview.problemRows", { count: preview.counts.problemRows })}`
								: ""}
							{preview.files > 0 ? ` · ${t("imports.preview.files", { count: preview.files })}` : ""}
						</p>
						{preview.problemsTotal > 0 ? (
							<Button
								variant="ghost"
								size="sm"
								aria-expanded={open}
								aria-controls={listId}
								onClick={() => setOpen((shown) => !shown)}
							>
								{open ? t("imports.preview.hideRows") : t("imports.preview.seeRows")}
							</Button>
						) : null}
					</div>
					{preview.skippedColumns.length > 0 ? (
						<p className="text-muted-foreground text-sm">
							{t("imports.preview.skippedColumns", { columns: preview.skippedColumns.join(", ") })}
						</p>
					) : null}
					<div id={listId} hidden={!open}>
						<ProblemList problems={preview.problems} total={preview.problemsTotal} />
					</div>
				</>
			) : (
				<p className="text-muted-foreground flex items-center gap-2 text-sm">
					<LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
					{t("imports.preview.working")}
				</p>
			)}
		</div>
	);
}

/** Problems by row and column, each with what is wrong in words. */
export function ProblemList({
	problems,
	total,
}: {
	problems: readonly { row: number; column: string | null; rule: string; params: unknown }[];
	total: number;
}) {
	const t = useT();
	if (problems.length === 0) return <p className="text-muted-foreground text-sm">{t("imports.report.noProblems")}</p>;
	return (
		<div className="grid gap-2">
			<div className="rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead className="ps-4">{t("imports.report.row")}</TableHead>
							<TableHead>{t("imports.map.column")}</TableHead>
							<TableHead className="pe-4">{t("imports.report.problem")}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{problems.map((problem, index) => {
							const { key, values } = problemWording({
								rule: problem.rule,
								params: problem.params as Record<string, string | number> | null,
							});
							return (
								// Problems are listed once each, in row order.
								// biome-ignore lint/suspicious/noArrayIndexKey: a row can have several problems in one column.
								<TableRow key={`${problem.row}-${index}`}>
									<TableCell className="ps-4">{problem.row}</TableCell>
									<TableCell>{problem.column ? <code className="text-xs">{problem.column}</code> : "—"}</TableCell>
									<TableCell className="pe-4 whitespace-normal">{t(key, values)}</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</div>
			{total > problems.length ? (
				<p className="text-muted-foreground text-sm">
					{t("imports.report.moreProblems", { count: total - problems.length })}
				</p>
			) : null}
		</div>
	);
}
