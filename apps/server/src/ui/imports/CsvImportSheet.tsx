import { useNavigate } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@webcraft/ui/components/sheet.tsx";
import { LoaderIcon, LockIcon, UploadIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { CsvFileCard, CsvMappingEditor, PreviewSummary, usePreview } from "./CsvMapping.tsx";
import {
	type CsvFileView,
	type CsvSettings,
	columnTargets,
	fileRefusal,
	type ImportPostType,
	nameOfFile,
	suggestedColumns,
	suggestedMatch,
} from "./model.ts";
import { Note } from "./Note.tsx";

/**
 * Import CSV, from a Post Type's Entries, in a side sheet: a CSV file's rows become Drafts of this
 * Post Type. Choose the file, where each column goes and what rows match existing Entries by, see
 * what the run would do, then start it; the run's page follows its progress. For Staff, Owners and
 * Editors (`import.run`).
 */
export function CsvImportSheet({
	siteId,
	postType,
	languages,
	addsFields,
}: {
	siteId: string;
	postType: ImportPostType;
	languages: { default: string; all: readonly string[] };
	/** Whether the person may add Fields (Staff): otherwise the sheet says only the agency can. */
	addsFields: boolean;
}) {
	const t = useT();
	const navigate = useNavigate();
	const ids = useId();
	const trigger = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [file, setFile] = useState<CsvFileView | null>(null);
	const [settings, setSettings] = useState<CsvSettings | null>(null);
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState<{ key: MessageKey; values?: Record<string, number> } | null>(null);
	const [busy, setBusy] = useState(false);
	const targets = columnTargets(postType, { title: t("content.builtIn.title"), slug: t("content.builtIn.slug") });
	const { preview, error: previewError, loading } = usePreview(siteId, file?.id ?? null, settings);

	const choose = async (chosen: File | undefined) => {
		if (!chosen) return;
		setUploading(true);
		setError(null);
		try {
			const api = await getApi();
			const { file: uploaded } = await api.imports.uploadCsv({ siteId, file: chosen });
			const columns = suggestedColumns(
				uploaded.columns.map((column) => column.name),
				targets,
			);
			setFile(uploaded);
			setSettings({ postTypeId: postType.id, language: null, match: suggestedMatch(columns, targets), columns });
		} catch (failure) {
			setError(fileRefusal(failure) ?? { key: errorMessage(failure) });
		} finally {
			setUploading(false);
		}
	};

	const start = async () => {
		if (!file || !settings) return;
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			const { import: created } = await api.imports.create({
				siteId,
				name: nameOfFile(file.fileName),
				source: "csv",
				settings,
			});
			const { run } = await api.imports.start({ siteId, importId: created.id, fileId: file.id });
			setOpen(false);
			await navigate({
				to: "/sites/$siteId/imports/$importId/runs/$runId",
				params: { siteId, importId: created.id, runId: run.id },
			});
		} catch (failure) {
			setError({ key: errorMessage(failure) });
		} finally {
			setBusy(false);
		}
	};

	const reset = () => {
		setFile(null);
		setSettings(null);
		setError(null);
	};

	const ready = Boolean(file && settings && preview && !previewError && !loading);
	return (
		<>
			<Button ref={trigger} variant="outline" onClick={() => setOpen(true)}>
				<UploadIcon aria-hidden="true" />
				{t("imports.sheet.open")}
			</Button>
			<Sheet
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) reset();
				}}
			>
				<SheetContent
					className="gap-0 data-[side=right]:sm:max-w-2xl"
					closeLabel={t("imports.sheet.close")}
					finalFocus={trigger}
				>
					<SheetHeader className="border-b p-6">
						<SheetTitle>{t("imports.sheet.title", { name: postType.name })}</SheetTitle>
						<SheetDescription>{t("imports.sheet.intro")}</SheetDescription>
					</SheetHeader>
					<div className="grid flex-1 content-start gap-6 overflow-y-auto p-6">
						{file && settings ? (
							<>
								<CsvFileCard
									file={file}
									action={
										<Button variant="ghost" size="sm" onClick={reset}>
											{t("imports.file.change")}
										</Button>
									}
								/>
								<CsvMappingEditor
									file={file}
									targets={targets}
									settings={settings}
									onChange={setSettings}
									languages={languages}
								/>
								{addsFields ? null : (
									<Note icon={<LockIcon className="size-4" aria-hidden="true" />}>
										{t("imports.sheet.fieldsByAgency")}
									</Note>
								)}
								<PreviewSummary preview={preview} error={previewError} loading={loading} />
							</>
						) : (
							<Field data-invalid={error ? true : undefined}>
								<FieldLabel htmlFor={`${ids}-file`}>{t("imports.file.label")}</FieldLabel>
								<Input
									id={`${ids}-file`}
									type="file"
									accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values"
									disabled={uploading}
									aria-describedby={`${ids}-file-help${error ? ` ${ids}-file-error` : ""}`}
									aria-invalid={error ? true : undefined}
									onChange={(event) => {
										void choose(event.target.files?.[0]);
										event.target.value = "";
									}}
								/>
								<FieldDescription id={`${ids}-file-help`}>{t("imports.file.help")}</FieldDescription>
								{uploading ? (
									<p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
										<LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
										{t("imports.file.reading")}
									</p>
								) : null}
								{error ? <FieldError id={`${ids}-file-error`}>{t(error.key, error.values)}</FieldError> : null}
							</Field>
						)}
						{file && error ? <FieldError>{t(error.key, error.values)}</FieldError> : null}
					</div>
					<SheetFooter className="flex-row justify-end gap-2 border-t p-6">
						<SheetClose render={<Button variant="outline" type="button" />}>{t("imports.sheet.cancel")}</SheetClose>
						<Button onClick={start} disabled={!ready || busy}>
							{busy ? <LoaderIcon className="animate-spin" aria-hidden="true" /> : <UploadIcon aria-hidden="true" />}
							{t("imports.sheet.start", { count: file?.rows ?? 0 })}
						</Button>
					</SheetFooter>
				</SheetContent>
			</Sheet>
		</>
	);
}
