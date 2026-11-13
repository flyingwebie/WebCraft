import { CLASS_NAME, isReservedName } from "@webcraft/renderer/builder";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";

import { getApi } from "../api.ts";
import { useT } from "../i18n.tsx";
import { DeclarationsEditor } from "./DeclarationsEditor.tsx";
import type { Editing } from "./DesignSystemScreen.tsx";
import { type EditableClass, html } from "./model.ts";
import { StylePreview } from "./StylePreview.tsx";

/**
 * The Classes tab: the Site's Classes, searched by name (generated ones hidden unless asked for), and
 * the selected Class's style panel: its name, its styles for every width, its styles from each
 * breakpoint up and its own CSS (rules nested with `&`), each value offering Design tokens first,
 * beside a live preview of an element with the Class. New Classes are made here too; deleting one an
 * element or CSS uses is refused with where.
 */
export function ClassesTab({
	editing,
	selected,
	onSelect,
}: {
	editing: Editing;
	selected?: string;
	onSelect(classId: string | undefined): void;
}) {
	const t = useT();
	const id = useId();
	const [query, setQuery] = useState("");
	const [showGenerated, setShowGenerated] = useState(false);
	const [newName, setNewName] = useState("");
	const [newProblem, setNewProblem] = useState<string | null>(null);
	const { classes } = editing.draft;
	const generatedCount = classes.filter((each) => each.generated).length;
	const shown = classes.filter(
		(each) =>
			(showGenerated || !each.generated || each.id === selected) &&
			each.name.toLowerCase().includes(query.trim().toLowerCase().replace(/^\./, "")),
	);
	const current = classes.find((each) => each.id === selected) ?? null;

	const create = async (event: FormEvent) => {
		event.preventDefault();
		const name = newName.trim().replace(/^\./, "");
		if (!CLASS_NAME.test(name) || isReservedName(name)) {
			setNewProblem(t("designSystem.classes.nameInvalid"));
			return;
		}
		setNewProblem(null);
		const made = await editing.now(async () => {
			const api = await getApi();
			return api.designSystem.createClass({ siteId: editing.siteId, name });
		});
		if (!made) return;
		editing.replaceDraft(made.designSystem.draft);
		setNewName("");
		onSelect(made.class.id);
	};

	return (
		<div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
			<div className="grid content-start gap-4">
				<form onSubmit={create} className="grid gap-2" noValidate>
					<Field data-invalid={newProblem ? true : undefined}>
						<FieldLabel htmlFor={`${id}-new`}>{t("designSystem.classes.new")}</FieldLabel>
						<div className="flex gap-2">
							<Input
								id={`${id}-new`}
								value={newName}
								onChange={(event) => setNewName(event.target.value)}
								className="font-mono"
								spellCheck={false}
								autoComplete="off"
								aria-invalid={newProblem ? true : undefined}
							/>
							<Button type="submit" variant="outline" aria-label={t("designSystem.classes.create")}>
								<PlusIcon aria-hidden="true" />
							</Button>
						</div>
						{newProblem ? <FieldError>{newProblem}</FieldError> : null}
					</Field>
				</form>
				<search className="grid gap-2">
					<Label htmlFor={`${id}-search`} className="flex items-center gap-1.5">
						<SearchIcon className="size-3.5" aria-hidden="true" />
						{t("designSystem.classes.search")}
					</Label>
					<Input
						id={`${id}-search`}
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						aria-controls={`${id}-list`}
						autoComplete="off"
					/>
					{generatedCount > 0 ? (
						<div className="flex items-center gap-2">
							<Checkbox
								id={`${id}-generated`}
								checked={showGenerated}
								onCheckedChange={(checked) => setShowGenerated(checked === true)}
							/>
							<Label htmlFor={`${id}-generated`} className="text-sm font-normal">
								{t("designSystem.classes.showGenerated", { count: generatedCount })}
							</Label>
						</div>
					) : null}
				</search>
				<p role="status" className="text-muted-foreground text-xs">
					{t("designSystem.classes.count", { shown: shown.length, count: classes.length })}
				</p>
				<ul
					id={`${id}-list`}
					aria-label={t("designSystem.classes.list")}
					className="grid max-h-[32rem] gap-0.5 overflow-y-auto"
				>
					{shown.map((each) => (
						<li key={each.id}>
							<button
								type="button"
								aria-pressed={each.id === selected}
								onClick={() => onSelect(each.id)}
								className="hover:bg-muted aria-pressed:bg-muted focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm outline-none focus-visible:ring-3 aria-pressed:font-medium"
							>
								<span className="truncate font-mono">.{each.name}</span>
								{each.generated ? (
									<Badge variant="outline" className="ms-auto">
										{t("designSystem.classes.generated")}
									</Badge>
								) : null}
								<span className="text-muted-foreground ms-auto text-xs">
									{editing.preview.uses.classes[each.id] ?? 0}
								</span>
							</button>
						</li>
					))}
				</ul>
				{classes.length === 0 ? (
					<p className="text-muted-foreground text-sm">{t("designSystem.classes.none")}</p>
				) : null}
			</div>
			{current ? (
				<ClassPanel key={current.id} editing={editing} found={current} onDeleted={() => onSelect(undefined)} />
			) : (
				<p className="text-muted-foreground text-sm">{t("designSystem.classes.pick")}</p>
			)}
		</div>
	);
}

/** One Class's style panel: name, styles for every width, from each breakpoint up, and its own CSS. */
function ClassPanel({ editing, found, onDeleted }: { editing: Editing; found: EditableClass; onDeleted(): void }) {
	const t = useT();
	const id = useId();
	const [name, setName] = useState(found.name);
	const nameValid = CLASS_NAME.test(name) && !isReservedName(name);
	const { tokens } = editing.draft;
	const current = editing.draft.classes.find((each) => each.id === found.id) ?? found;

	const sample = `<div class="${html(current.name)}"><h2>${html(t("designSystem.classes.sampleHeading"))}</h2><p>${html(t("designSystem.classes.sampleText"))} <a href="#">${html(t("designSystem.classes.sampleLink"))}</a></p></div>`;

	return (
		<section aria-labelledby={`${id}-heading`} className="grid min-w-0 content-start gap-6">
			<div className="flex flex-wrap items-center gap-3">
				<h2 id={`${id}-heading`} className="font-mono text-lg font-semibold">
					.{current.name}
				</h2>
				{current.generated ? <Badge variant="outline">{t("designSystem.classes.generated")}</Badge> : null}
				<Badge variant="secondary">
					{t("designSystem.uses", { count: editing.preview.uses.classes[current.id] ?? 0 })}
				</Badge>
				<DeleteClass editing={editing} found={current} onDeleted={onDeleted} />
			</div>
			{current.generated ? (
				<p className="text-muted-foreground text-sm">{t("designSystem.classes.generatedHelp")}</p>
			) : null}
			<Field data-invalid={nameValid ? undefined : true}>
				<FieldLabel htmlFor={`${id}-name`}>{t("designSystem.classes.name")}</FieldLabel>
				<Input
					id={`${id}-name`}
					value={name}
					onChange={(event) => {
						setName(event.target.value);
						const next = event.target.value;
						if (CLASS_NAME.test(next) && !isReservedName(next)) editing.changeClass(found.id, { name: next });
					}}
					className="max-w-sm font-mono"
					spellCheck={false}
					autoComplete="off"
					aria-invalid={nameValid ? undefined : true}
					aria-describedby={`${id}-name-help`}
				/>
				<FieldDescription id={`${id}-name-help`}>{t("designSystem.classes.nameHelp")}</FieldDescription>
				{nameValid ? null : <FieldError>{t("designSystem.classes.nameInvalid")}</FieldError>}
			</Field>
			<p id={`${id}-tokens-help`} className="text-muted-foreground text-sm">
				{t("designSystem.classes.tokensFirst")}
			</p>
			<DeclarationsEditor
				label={t("designSystem.classes.styles")}
				css={found.styles}
				tokens={tokens}
				describedBy={`${id}-tokens-help`}
				onChange={(styles) => editing.changeClass(found.id, { styles })}
			/>
			{tokens.breakpoints.map((breakpoint) => (
				<DeclarationsEditor
					key={breakpoint.id}
					label={t("designSystem.classes.fromBreakpoint", { name: breakpoint.name, width: breakpoint.width })}
					css={found.breakpoints[breakpoint.id] ?? ""}
					tokens={tokens}
					onChange={(css) => {
						const breakpoints = { ...current.breakpoints, [breakpoint.id]: css };
						if (!css) delete breakpoints[breakpoint.id];
						editing.changeClass(found.id, { breakpoints });
					}}
				/>
			))}
			<Field>
				<FieldLabel htmlFor={`${id}-css`}>{t("designSystem.classes.ownCss")}</FieldLabel>
				<Textarea
					id={`${id}-css`}
					value={found.css}
					onChange={(event) => editing.changeClass(found.id, { css: event.target.value })}
					className="min-h-28 font-mono text-xs"
					spellCheck={false}
					aria-describedby={`${id}-css-help`}
				/>
				<FieldDescription id={`${id}-css-help`}>{t("designSystem.classes.ownCssHelp")}</FieldDescription>
			</Field>
			<StylePreview
				title={t("designSystem.classes.previewTitle", { name: current.name })}
				stylesheet={editing.preview.stylesheet}
				markup={sample}
				mode={editing.mode}
			/>
		</section>
	);
}

function DeleteClass({ editing, found, onDeleted }: { editing: Editing; found: EditableClass; onDeleted(): void }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const remove = async () => {
		setBusy(true);
		setOpen(false);
		const done = await editing.now(async () => {
			const api = await getApi();
			return api.designSystem.deleteClass({ siteId: editing.siteId, classId: found.id });
		});
		setBusy(false);
		if (!done || !("designSystem" in done)) return;
		editing.replaceDraft(done.designSystem.draft);
		onDeleted();
	};
	return (
		<>
			<Button
				ref={trigger}
				type="button"
				variant="outline"
				size="sm"
				className="ms-auto"
				disabled={busy}
				onClick={() => setOpen(true)}
			>
				<Trash2Icon aria-hidden="true" />
				{t("designSystem.classes.delete")}
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent closeLabel={t("designSystem.close")} finalFocus={trigger}>
					<DialogHeader>
						<DialogTitle>{t("designSystem.classes.deleteTitle", { name: found.name })}</DialogTitle>
						<DialogDescription>{t("designSystem.classes.deleteBody")}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("designSystem.cancel")}</DialogClose>
						<Button type="button" variant="destructive" onClick={remove}>
							{t("designSystem.classes.deleteConfirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
