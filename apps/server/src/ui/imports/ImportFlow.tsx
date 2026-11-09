import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import {
	ArrowLeftIcon,
	ArrowRightIcon,
	CalendarClockIcon,
	FileLockIcon,
	LoaderIcon,
	PlayIcon,
	ShieldCheckIcon,
	TableIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { CsvFileCard, CsvMappingEditor, PreviewSummary, usePreview } from "./CsvMapping.tsx";
import {
	type ColumnTarget,
	type CsvFileView,
	type CsvSettings,
	columnTargets,
	fileRefusal,
	type ImportPostType,
	type ImportView,
	nameOfFile,
	suggestedColumns,
	suggestedMatch,
} from "./model.ts";
import { Note } from "./Note.tsx";
import { type ImportStep, Stepper } from "./Stepper.tsx";

type Step = Extract<ImportStep, "source" | "map" | "preview">;

/**
 * The first three steps of an Import: Source (the file, the Post Type, a name), Map (where each column
 * goes, what rows match Entries by) and Preview (what the run would do), then Start, which opens the
 * run. For a new Import, or to run an Import again with a new file (its settings kept, columns
 * matched by name).
 */
export function ImportFlow({
	siteId,
	postTypes,
	languages,
	existing,
}: {
	siteId: string;
	postTypes: readonly { id: string; name: string; builtIn: string | null }[];
	languages: { default: string; all: readonly string[] };
	existing: ImportView | null;
}) {
	const t = useT();
	const navigate = useNavigate();
	const ids = useId();
	const heading = useRef<HTMLHeadingElement>(null);
	const [step, setStep] = useState<Step>("source");
	const [name, setName] = useState(existing?.name ?? "");
	// An Import that keeps track of Entries it brought in keeps its Post Type (the server refuses a change).
	const postTypeFixed = (existing?.entries ?? 0) > 0;
	// A Post Type Staff made, rather than Pages, unless the Import already has one.
	const [postTypeId, setPostTypeId] = useState(
		existing?.settings.postTypeId ?? (postTypes.find((type) => type.builtIn === null) ?? postTypes[0])?.id ?? "",
	);
	const [loadedPostType, setPostType] = useState<ImportPostType | null>(null);
	// The chosen Post Type, once its Fields are loaded.
	const postType = loadedPostType?.id === postTypeId ? loadedPostType : null;
	const [file, setFile] = useState<CsvFileView | null>(null);
	const [settings, setSettings] = useState<CsvSettings | null>(null);
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState<{ key: MessageKey; values?: Record<string, number> } | null>(null);
	const [busy, setBusy] = useState(false);
	const targets: ColumnTarget[] = postType
		? columnTargets(postType, { title: t("content.builtIn.title"), slug: t("content.builtIn.slug") })
		: [];
	const {
		preview,
		error: previewError,
		loading,
	} = usePreview(siteId, step === "source" ? null : (file?.id ?? null), settings, existing?.id);

	// The chosen Post Type with its Fields, for mapping.
	useEffect(() => {
		if (!postTypeId) return;
		let current = true;
		void (async () => {
			const api = await getApi();
			const { postType: found } = await api.postTypes.get({ siteId, postTypeId });
			if (current) setPostType(found);
		})();
		return () => {
			current = false;
		};
	}, [siteId, postTypeId]);

	// A new step starts with its heading focused, so a screen reader hears where it is (not on the
	// page's first load: the skip link comes first there).
	const shownStep = useRef(step);
	useEffect(() => {
		if (shownStep.current === step) return;
		shownStep.current = step;
		heading.current?.focus();
	}, [step]);

	const choose = async (chosen: File | undefined) => {
		if (!chosen) return;
		setUploading(true);
		setError(null);
		try {
			const api = await getApi();
			const { file: uploaded } = await api.imports.uploadCsv({ siteId, file: chosen });
			setFile(uploaded);
			if (!name.trim()) setName(nameOfFile(uploaded.fileName));
		} catch (failure) {
			setError(fileRefusal(failure) ?? { key: errorMessage(failure) });
		} finally {
			setUploading(false);
		}
	};

	/** Settings for the file: the Import's own, columns matched by name, or suggested ones. */
	const settingsFor = (chosen: CsvFileView): CsvSettings => {
		const names = chosen.columns.map((column) => column.name);
		if (existing && existing.settings.postTypeId === postTypeId) {
			const known = new Map(existing.settings.columns.map((column) => [column.column.toLocaleLowerCase(), column.to]));
			const suggested = suggestedColumns(names, targets);
			const columns = names.map((column, index) =>
				known.has(column.toLocaleLowerCase())
					? { column, to: known.get(column.toLocaleLowerCase()) ?? null }
					: (suggested[index] ?? { column, to: null }),
			);
			return { ...existing.settings, columns };
		}
		const columns = suggestedColumns(names, targets);
		return { postTypeId, language: null, match: suggestedMatch(columns, targets), columns };
	};

	const toMap = () => {
		if (!file || !postType) {
			setError({ key: file ? "imports.flow.choosePostType" : "imports.flow.chooseFile" });
			return;
		}
		if (!name.trim()) {
			setError({ key: "imports.flow.nameRequired" });
			return;
		}
		setError(null);
		if (!settings || settings.postTypeId !== postTypeId) setSettings(settingsFor(file));
		setStep("map");
	};

	const start = async () => {
		if (!file || !settings) return;
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			const importId = existing
				? (await api.imports.update({ siteId, importId: existing.id, name: name.trim(), settings })).import.id
				: (await api.imports.create({ siteId, name: name.trim(), source: "csv", settings })).import.id;
			const { run } = await api.imports.start({ siteId, importId, fileId: file.id });
			await navigate({
				to: "/sites/$siteId/imports/$importId/runs/$runId",
				params: { siteId, importId, runId: run.id },
			});
		} catch (failure) {
			setError({ key: errorMessage(failure) });
			setBusy(false);
		}
	};

	const titles: Record<Step, { title: string; next: ReactNode; onNext(): void; disabled: boolean }> = {
		source: {
			title: t("imports.flow.sourceIntro"),
			next: (
				<>
					<ArrowRightIcon className="rtl:rotate-180" aria-hidden="true" />
					{t("imports.flow.toMap")}
				</>
			),
			onNext: toMap,
			disabled: uploading,
		},
		map: {
			title: t("imports.flow.mapIntro"),
			next: (
				<>
					<ArrowRightIcon className="rtl:rotate-180" aria-hidden="true" />
					{t("imports.flow.toPreview")}
				</>
			),
			onNext: () => setStep("preview"),
			disabled: false,
		},
		preview: {
			title: t("imports.flow.previewIntro"),
			next: (
				<>
					{busy ? <LoaderIcon className="animate-spin" aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
					{t("imports.flow.start")}
				</>
			),
			onNext: () => void start(),
			disabled: busy || loading || !preview || Boolean(previewError),
		},
	};
	const current = titles[step];
	const back: Step | null = step === "map" ? "source" : step === "preview" ? "map" : null;

	return (
		<div className="grid gap-8">
			<header className="flex flex-wrap items-center gap-x-6 gap-y-4 border-b pb-6">
				<Button
					variant="ghost"
					size="icon"
					render={<Link to="/sites/$siteId/imports" params={{ siteId }} />}
					aria-label={t("imports.flow.backToList")}
				>
					<ArrowLeftIcon className="rtl:rotate-180" aria-hidden="true" />
				</Button>
				<div className="grid min-w-48 flex-1 gap-1">
					<h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
						{existing ? existing.name : t("imports.flow.newTitle")}
					</h1>
					<p className="text-muted-foreground text-sm">{current.title}</p>
				</div>
				<Stepper current={step} />
				<div className="flex items-center gap-2">
					{back ? (
						<Button variant="ghost" onClick={() => setStep(back)}>
							{t("imports.flow.back")}
						</Button>
					) : (
						<Button variant="ghost" render={<Link to="/sites/$siteId/imports" params={{ siteId }} />}>
							{t("imports.flow.cancel")}
						</Button>
					)}
					<Button onClick={current.onNext} disabled={current.disabled}>
						{current.next}
					</Button>
				</div>
			</header>

			{error ? (
				<FieldError id={`${ids}-error`} className="max-w-3xl">
					{t(error.key, error.values)}
				</FieldError>
			) : null}

			{step === "source" ? (
				<div className="grid gap-8 lg:grid-cols-[16rem_minmax(0,1fr)_18rem]">
					<fieldset className="grid content-start gap-3">
						<legend className="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">
							{t("imports.flow.source")}
						</legend>
						<label className="border-primary flex cursor-pointer items-start gap-3 rounded-lg border-2 p-4">
							<input type="radio" name={`${ids}-source`} value="csv" defaultChecked className="accent-primary mt-1" />
							<span className="grid gap-0.5">
								<span className="flex items-center gap-2 font-medium">
									<TableIcon className="size-4" aria-hidden="true" />
									{t("imports.sources.csv.title")}
								</span>
								<span className="text-muted-foreground text-sm">{t("imports.sources.csv.short")}</span>
							</span>
						</label>
					</fieldset>
					<section aria-labelledby={`${ids}-csv`} className="grid content-start gap-6 rounded-lg border p-6">
						<div className="grid gap-1">
							<h2 id={`${ids}-csv`} className="text-lg font-semibold">
								{t("imports.flow.csvTitle")}
							</h2>
							<p className="text-muted-foreground text-sm">{t("imports.flow.csvIntro")}</p>
						</div>
						<Field>
							<FieldLabel htmlFor={`${ids}-name`}>{t("imports.flow.name")}</FieldLabel>
							<Input
								id={`${ids}-name`}
								value={name}
								maxLength={200}
								aria-describedby={`${ids}-name-help`}
								onChange={(event) => setName(event.target.value)}
							/>
							<FieldDescription id={`${ids}-name-help`}>{t("imports.flow.nameHelp")}</FieldDescription>
						</Field>
						<Field>
							<FieldLabel htmlFor={`${ids}-post-type`}>{t("imports.flow.postType")}</FieldLabel>
							<NativeSelect
								id={`${ids}-post-type`}
								className="w-full"
								value={postTypeId}
								disabled={postTypeFixed}
								aria-describedby={postTypeFixed ? `${ids}-post-type-help` : undefined}
								onChange={(event) => setPostTypeId(event.target.value)}
							>
								{postTypes.map((type) => (
									<NativeSelectOption key={type.id} value={type.id}>
										{type.name}
									</NativeSelectOption>
								))}
							</NativeSelect>
							{postTypeFixed ? (
								<FieldDescription id={`${ids}-post-type-help`}>{t("imports.flow.postTypeFixed")}</FieldDescription>
							) : null}
						</Field>
						{file ? (
							<CsvFileCard
								file={file}
								action={
									<Button variant="ghost" size="sm" onClick={() => setFile(null)}>
										{t("imports.file.change")}
									</Button>
								}
							/>
						) : (
							<Field>
								<FieldLabel htmlFor={`${ids}-file`}>{t("imports.file.label")}</FieldLabel>
								<Input
									id={`${ids}-file`}
									type="file"
									accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
									disabled={uploading}
									aria-describedby={`${ids}-file-help`}
									onChange={(event) => {
										void choose(event.target.files?.[0]);
										event.target.value = "";
									}}
								/>
								<FieldDescription id={`${ids}-file-help`}>
									{existing ? t("imports.flow.fileAgain") : t("imports.file.help")}
								</FieldDescription>
								{uploading ? (
									<p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
										<LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
										{t("imports.file.reading")}
									</p>
								) : null}
							</Field>
						)}
					</section>
					<aside aria-labelledby={`${ids}-know`} className="grid content-start gap-3">
						<h2 id={`${ids}-know`} className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
							{t("imports.flow.goodToKnow")}
						</h2>
						<Note icon={<FileLockIcon className="size-4" aria-hidden="true" />}>{t("imports.flow.notePrivate")}</Note>
						<Note icon={<CalendarClockIcon className="size-4" aria-hidden="true" />}>{t("imports.flow.noteKept")}</Note>
						<Note icon={<ShieldCheckIcon className="size-4" aria-hidden="true" />}>{t("imports.flow.noteDrafts")}</Note>
					</aside>
				</div>
			) : null}

			{step === "map" && file && settings ? (
				<div className="grid max-w-4xl gap-6">
					<CsvFileCard file={file} />
					<CsvMappingEditor
						file={file}
						targets={targets}
						settings={settings}
						onChange={setSettings}
						languages={languages}
						headingLevel={2}
					/>
					<PreviewSummary preview={preview} error={previewError} loading={loading} />
				</div>
			) : null}

			{step === "preview" && file && settings ? (
				<div className="grid max-w-4xl gap-6">
					<CsvFileCard file={file} />
					<PreviewSummary preview={preview} error={previewError} loading={loading} />
					<Note icon={<ShieldCheckIcon className="size-4" aria-hidden="true" />}>{t("imports.flow.noteDrafts")}</Note>
				</div>
			) : null}
		</div>
	);
}
