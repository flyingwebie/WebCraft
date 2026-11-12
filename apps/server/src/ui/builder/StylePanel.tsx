import { readInlineStyle } from "@webcraft/renderer/builder";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, XIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { useEditorApi } from "../builder/editor-api.tsx";
import { cssOf, type Declaration, declarationsOf, PROPERTIES } from "../design-system/declarations.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import type { Catalogue } from "./model.ts";

/**
 * The style panel of the selected element: its Classes in order (ADR 0009) with their names, moved,
 * removed, added from the Site's Classes and token utilities, or made as a new Class of the Design
 * system's Draft; a Class's styles, edited as declarations that offer the tokens' variables first;
 * and its one-off style, which becomes a generated Class when the Template or Component is saved,
 * as an inline style in Template markup does. Pages never carry inline styles.
 */
export function StylePanel({
	classesInDock = false,
	departure,
	siteId,
	catalogue,
	classIds,
	oneOff,
	onClasses,
	onOneOff,
	refreshCatalogue,
}: {
	classesInDock?: boolean;
	departure?: { current: (() => Promise<boolean>) | null };
	siteId: string;
	catalogue: Catalogue;
	/** The element's Classes and token utilities, in order. */
	classIds: readonly string[];
	/** Its one-off style: unsaved declarations, or its generated Class's. */
	oneOff: string;
	onClasses(classIds: string[], announcement: string): void;
	onOneOff(declarations: string): boolean | Promise<boolean>;
	/** A Class was made or changed in the Design system's Draft. */
	refreshCatalogue(): Promise<void>;
}) {
	const t = useT();
	const getApi = useEditorApi();
	const id = useId();
	const [adding, setAdding] = useState("");
	const [addProblem, setAddProblem] = useState<string | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [oneOffText, setOneOffText] = useState(oneOff);
	const [oneOffProblem, setOneOffProblem] = useState<string | null>(null);
	const [applyingOneOff, setApplyingOneOff] = useState(false);
	const oneOffSaving = useRef(false);
	const oneOffEdit = useRef(0);
	const appliedOneOffEdit = useRef(0);
	const current = useRef({ catalogue, classIds, onClasses, refreshCatalogue });
	current.current = { catalogue, classIds, onClasses, refreshCatalogue };
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		if (oneOffEdit.current === appliedOneOffEdit.current) {
			setOneOffText(oneOff);
			setOneOffProblem(null);
		}
	}, [oneOff]);

	const nameOf = (classId: string) =>
		catalogue.classes.find((each) => each.id === classId)?.name ??
		catalogue.utilities.find((each) => each.id === classId)?.name ??
		classId;
	const named = classIds.filter((classId) => !catalogue.classes.find((each) => each.id === classId)?.generated);
	const generated = classIds.filter((classId) => catalogue.classes.find((each) => each.id === classId)?.generated);

	const move = (index: number, step: -1 | 1) => {
		const next = [...named];
		const [moved] = next.splice(index, 1);
		if (moved === undefined) return;
		next.splice(index + step, 0, moved);
		onClasses(
			[...next, ...generated],
			t("builder.style.moved", { name: nameOf(moved), position: index + step + 1, count: next.length }),
		);
	};

	const add = async (event: FormEvent) => {
		event.preventDefault();
		setAddProblem(null);
		const name = adding.trim().replace(/^\./, "");
		if (!name) return;
		const found =
			catalogue.classes.find((each) => each.name === name && !each.generated) ??
			catalogue.utilities.find((each) => each.name === name);
		if (found) {
			if (classIds.includes(found.id)) return setAddProblem(t("builder.style.already", { name }));
			onClasses([...named, found.id, ...generated], t("builder.style.added", { name }));
			setAdding("");
			return;
		}
		try {
			const api = await getApi();
			const made = await api.designSystem.createClass({ siteId, name });
			if (!mounted.current) return;
			await current.current.refreshCatalogue();
			if (!mounted.current) return;
			// Attach the new Class to the current element without restoring an old tree or Class list.
			const latest = current.current;
			const generatedIds = new Set(latest.catalogue.classes.filter((each) => each.generated).map((each) => each.id));
			if (!latest.classIds.includes(made.class.id))
				latest.onClasses(
					[
						...latest.classIds.filter((id) => !generatedIds.has(id)),
						made.class.id,
						...latest.classIds.filter((id) => generatedIds.has(id)),
					],
					t("builder.style.created", { name }),
				);
			setAdding("");
			setEditing(made.class.id);
		} catch (failure) {
			const problems = (failure as { data?: { problems?: { message: string }[] } }).data?.problems;
			setAddProblem(problems?.length ? problems.map((each) => each.message).join(" ") : t(errorMessage(failure)));
		}
	};

	const applyOneOff = async (): Promise<boolean> => {
		if (oneOffSaving.current) return false;
		const read = readInlineStyle(oneOffText);
		if ("problem" in read) {
			setOneOffProblem(read.problem);
			return false;
		}
		setOneOffProblem(null);
		oneOffSaving.current = true;
		setApplyingOneOff(true);
		const revision = oneOffEdit.current;
		try {
			if (!(await onOneOff(read.declarations))) return false;
			appliedOneOffEdit.current = revision;
			if (oneOffEdit.current === revision) setOneOffText(read.declarations);
			return oneOffEdit.current === revision;
		} catch (failure) {
			setOneOffProblem(t(errorMessage(failure)));
			return false;
		} finally {
			oneOffSaving.current = false;
			setApplyingOneOff(false);
		}
	};
	const applyNow = useRef(applyOneOff);
	applyNow.current = applyOneOff;
	useEffect(() => {
		if (!departure) return;
		const flush = async () =>
			!oneOffSaving.current && (oneOffEdit.current === appliedOneOffEdit.current || (await applyNow.current()));
		departure.current = flush;
		return () => {
			if (departure.current === flush) departure.current = null;
		};
	}, [departure]);

	return (
		<div className="grid gap-6">
			{!classesInDock ? (
				<section aria-labelledby={`${id}-classes`} className="grid gap-2">
					<h3 id={`${id}-classes`} className="text-sm font-semibold">
						{t("builder.style.classes")}
					</h3>
					{named.length === 0 ? (
						<p className="text-muted-foreground text-sm">{t("builder.style.noClasses")}</p>
					) : (
						<ol className="grid gap-1">
							{named.map((classId, index) => {
								const name = nameOf(classId);
								const own = catalogue.classes.some((each) => each.id === classId);
								return (
									<li key={classId} className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm">
										<span className="truncate font-mono">.{name}</span>
										<span className="ms-auto flex shrink-0">
											{own ? (
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													aria-label={t("builder.style.edit", { name })}
													aria-pressed={editing === classId}
													onClick={() => setEditing(editing === classId ? null : classId)}
												>
													<PencilIcon aria-hidden="true" />
												</Button>
											) : null}
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												disabled={index === 0}
												aria-label={t("builder.style.moveUp", { name })}
												onClick={() => move(index, -1)}
											>
												<ArrowUpIcon aria-hidden="true" />
											</Button>
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												disabled={index === named.length - 1}
												aria-label={t("builder.style.moveDown", { name })}
												onClick={() => move(index, 1)}
											>
												<ArrowDownIcon aria-hidden="true" />
											</Button>
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												aria-label={t("builder.style.remove", { name })}
												onClick={() =>
													onClasses(
														[...named.filter((each) => each !== classId), ...generated],
														t("builder.style.removed", { name }),
													)
												}
											>
												<XIcon aria-hidden="true" />
											</Button>
										</span>
									</li>
								);
							})}
						</ol>
					)}
					<form onSubmit={add} className="grid gap-2" noValidate>
						<Field data-invalid={addProblem ? true : undefined}>
							<FieldLabel htmlFor={`${id}-add`}>{t("builder.style.add")}</FieldLabel>
							<div className="flex gap-2">
								<Input
									id={`${id}-add`}
									list={`${id}-names`}
									value={adding}
									onChange={(event) => setAdding(event.target.value)}
									className="font-mono"
									spellCheck={false}
									autoComplete="off"
									aria-invalid={addProblem ? true : undefined}
									aria-describedby={`${id}-add-help`}
								/>
								<Button type="submit" variant="outline">
									{t("builder.style.addSubmit")}
								</Button>
							</div>
							<datalist id={`${id}-names`}>
								{catalogue.classes
									.filter((each) => !each.generated)
									.map((each) => (
										<option key={each.id} value={each.name} />
									))}
								{catalogue.utilities.map((each) => (
									<option key={each.id} value={each.name} />
								))}
							</datalist>
							<FieldDescription id={`${id}-add-help`}>{t("builder.style.addHelp")}</FieldDescription>
							{addProblem ? <FieldError>{addProblem}</FieldError> : null}
						</Field>
					</form>
				</section>
			) : null}
			{!classesInDock && editing && catalogue.classes.some((each) => each.id === editing) ? (
				<ClassEditor key={editing} siteId={siteId} catalogue={catalogue} classId={editing} onSaved={refreshCatalogue} />
			) : null}
			<section aria-labelledby={`${id}-one-off`} className="grid gap-2">
				<h3 id={`${id}-one-off`} className="text-sm font-semibold">
					{t("builder.style.oneOff")}
				</h3>
				<Field data-invalid={oneOffProblem ? true : undefined}>
					<FieldLabel htmlFor={`${id}-one-off-text`}>{t("builder.style.oneOffLabel")}</FieldLabel>
					<Textarea
						id={`${id}-one-off-text`}
						value={oneOffText}
						onChange={(event) => {
							oneOffEdit.current++;
							setOneOffText(event.target.value);
						}}
						className="min-h-20 font-mono text-xs"
						spellCheck={false}
						aria-invalid={oneOffProblem ? true : undefined}
						aria-describedby={`${id}-one-off-help`}
					/>
					<FieldDescription id={`${id}-one-off-help`}>{t("builder.style.oneOffHelp")}</FieldDescription>
					{oneOffProblem ? <FieldError>{oneOffProblem}</FieldError> : null}
				</Field>
				<Button
					type="button"
					variant="outline"
					className="justify-self-start"
					disabled={applyingOneOff}
					onClick={applyOneOff}
				>
					{t("builder.style.oneOffApply")}
				</Button>
			</section>
		</div>
	);
}

/**
 * A Class's styles for every width, as declarations: saved to the Design system's Draft, so every
 * element with the Class changes on the canvas, and on pages once the Design system is published.
 * Values offer the tokens' variables (`var(--space-m)`) first.
 */
function ClassEditor({
	siteId,
	catalogue,
	classId,
	onSaved,
}: {
	siteId: string;
	catalogue: Catalogue;
	classId: string;
	onSaved(): Promise<void>;
}) {
	const t = useT();
	const getApi = useEditorApi();
	const id = useId();
	const found = catalogue.classes.find((each) => each.id === classId);
	const [rows, setRows] = useState<Declaration[]>(() => [
		...declarationsOf(found?.styles ?? ""),
		{ property: "", value: "" },
	]);
	const [problem, setProblem] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const name = found?.name ?? "";
	const edit = useRef(0);
	const savedEdit = useRef(0);
	useEffect(() => {
		// Follow a co-editor's saved styles while retaining unfinished local declarations.
		if (!busy && edit.current === savedEdit.current)
			setRows([...declarationsOf(found?.styles ?? ""), { property: "", value: "" }]);
	}, [found?.styles, busy]);

	const change = (index: number, part: keyof Declaration, value: string) => {
		edit.current++;
		setRows((before) => {
			const next = before.map((row, at) => (at === index ? { ...row, [part]: value } : row));
			const last = next.at(-1);
			return last && (last.property || last.value) ? [...next, { property: "", value: "" }] : next;
		});
	};

	const save = async (event: FormEvent) => {
		event.preventDefault();
		setProblem(null);
		setBusy(true);
		const revision = edit.current;
		try {
			const api = await getApi();
			await api.designSystem.updateClass({ siteId, classId, styles: cssOf(rows) });
			savedEdit.current = revision;
			await onSaved();
		} catch (failure) {
			const problems = (failure as { data?: { problems?: { message: string }[] } }).data?.problems;
			setProblem(problems?.length ? problems.map((each) => each.message).join(" ") : t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<form onSubmit={save} aria-labelledby={`${id}-heading`} className="grid gap-3 rounded-md border p-3" noValidate>
			<h3 id={`${id}-heading`} className="text-sm font-semibold">
				{t("builder.style.classStyles", { name })}
			</h3>
			<p className="text-muted-foreground text-xs">{t("builder.style.classStylesHelp")}</p>
			<datalist id={`${id}-properties`}>
				{PROPERTIES.map((property) => (
					<option key={property} value={property} />
				))}
			</datalist>
			<datalist id={`${id}-tokens`}>
				{catalogue.tokens.map((token) => (
					<option key={token} value={`var(${token})`} />
				))}
			</datalist>
			<ol className="grid gap-2">
				{rows.map((row, index) => (
					// Rows have no identity of their own besides where they are.
					// biome-ignore lint/suspicious/noArrayIndexKey: declarations are edited in place.
					<li key={index} className="grid grid-cols-2 gap-2">
						<Input
							aria-label={t("builder.style.property", { number: index + 1 })}
							list={`${id}-properties`}
							value={row.property}
							onChange={(event) => change(index, "property", event.target.value)}
							className="font-mono text-xs"
							spellCheck={false}
							autoComplete="off"
						/>
						<Input
							aria-label={t("builder.style.value", { number: index + 1 })}
							list={`${id}-tokens`}
							value={row.value}
							onChange={(event) => change(index, "value", event.target.value)}
							className="font-mono text-xs"
							spellCheck={false}
							autoComplete="off"
						/>
					</li>
				))}
			</ol>
			{problem ? <FieldError>{problem}</FieldError> : null}
			<Button type="submit" variant="outline" className="justify-self-start" disabled={busy}>
				{t("builder.style.saveClass", { name })}
			</Button>
		</form>
	);
}
