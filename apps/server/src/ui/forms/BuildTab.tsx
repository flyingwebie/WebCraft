import { FORM_FIELD_TYPES } from "@webcraft/renderer/forms";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import {
	ArrowDownIcon,
	ArrowUpIcon,
	AtSignIcon,
	CalendarIcon,
	CircleDotIcon,
	CopyIcon,
	EllipsisIcon,
	EyeOffIcon,
	FootprintsIcon,
	GroupIcon,
	HashIcon,
	LinkIcon,
	ListChecksIcon,
	type LucideIcon,
	PaperclipIcon,
	PhoneIcon,
	SquareCheckIcon,
	SquareChevronDownIcon,
	TextIcon,
	TrashIcon,
	TypeIcon,
} from "lucide-react";
import { useState } from "react";

import { useT } from "../i18n.tsx";
import { FieldPanel } from "./FieldPanel.tsx";
import {
	duplicateField,
	type FormFieldType,
	type FormProblem,
	type FormVersion,
	fieldIndexOf,
	moveField,
	newField,
} from "./model.ts";

/** The icon of each type of field, in the palette and the list. */
export const FIELD_ICONS: Record<FormFieldType, LucideIcon> = {
	text: TypeIcon,
	email: AtSignIcon,
	phone: PhoneIcon,
	url: LinkIcon,
	textarea: TextIcon,
	number: HashIcon,
	date: CalendarIcon,
	select: SquareChevronDownIcon,
	radio: CircleDotIcon,
	checkboxes: ListChecksIcon,
	consent: SquareCheckIcon,
	hidden: EyeOffIcon,
	file: PaperclipIcon,
	section: GroupIcon,
	step: FootprintsIcon,
};

/**
 * The Build tab: a palette of the field types (each button adds one at the end), the Form's fields
 * in order (each selected to change its settings, moved, copied or removed from its menu, so every
 * change works from the keyboard), and the selected field's settings beside them. Sections and steps
 * are items of the list too: each holds the items after it (a section up to the next section or step,
 * a step up to the next step), which the list shows indented under it.
 */
export function BuildTab({
	version,
	onChange,
	problems,
}: {
	version: FormVersion;
	onChange: (version: FormVersion) => void;
	problems: readonly FormProblem[];
}) {
	const t = useT();
	const [selected, setSelected] = useState(0);
	const fields = version.fields;
	const current = Math.min(selected, fields.length - 1);
	const setFields = (next: FormVersion["fields"], select?: number) => {
		onChange({ ...version, fields: next });
		if (select !== undefined) setSelected(select);
	};
	const add = (type: FormFieldType) =>
		setFields([...fields, newField(fields, type, t(`forms.types.${type}`), t("forms.field.option"))], fields.length);

	return (
		<div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)_22rem]">
			<section aria-labelledby="palette-heading" className="grid content-start gap-2">
				<h2 id="palette-heading" className="text-muted-foreground text-xs font-medium uppercase">
					{t("forms.addField")}
				</h2>
				<ul className="grid gap-1.5">
					{FORM_FIELD_TYPES.map((type) => {
						const Icon = FIELD_ICONS[type];
						return (
							<li key={type}>
								<Button variant="outline" className="w-full justify-start" onClick={() => add(type)}>
									<Icon data-icon="inline-start" />
									<span className="sr-only">{t("forms.add")} </span>
									{t(`forms.types.${type}`)}
								</Button>
							</li>
						);
					})}
				</ul>
			</section>

			<section aria-labelledby="fields-heading" className="grid min-w-0 content-start gap-3">
				<h2 id="fields-heading" className="text-muted-foreground text-xs font-medium uppercase">
					{t("forms.fields")}
				</h2>
				{fields.length === 0 ? (
					<p className="text-muted-foreground rounded-md border border-dashed p-6 text-sm">{t("forms.noFields")}</p>
				) : (
					<ol className="grid min-w-0 gap-2">
						{fields.map((field, index) => {
							const Icon = FIELD_ICONS[field.type];
							const broken = problems.some((problem) => fieldIndexOf(problem) === index);
							const depth = depthOf(fields, index);
							return (
								<li
									// biome-ignore lint/suspicious/noArrayIndexKey: fields are edited in place, and their keys can repeat while typing.
									key={index}
									className={`flex min-w-0 items-center gap-2 rounded-md border p-2 ${depth === 2 ? "ms-8" : depth === 1 ? "ms-4" : ""} ${field.type === "step" || field.type === "section" ? "bg-muted/50" : ""} ${index === current ? "border-primary ring-primary/30 ring-2" : ""} ${broken ? "border-destructive" : ""}`}
								>
									<button
										type="button"
										className="focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1 py-1 text-start outline-none focus-visible:ring-3"
										aria-current={index === current ? "true" : undefined}
										onClick={() => setSelected(index)}
									>
										<Icon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
										<span className="truncate font-medium">
											{field.label.text}
											{field.required ? <span aria-hidden="true"> *</span> : null}
										</span>
										<Badge variant="outline">{t(`forms.types.${field.type}`)}</Badge>
										{field.condition ? <Badge variant="secondary">{t("forms.condition.badge")}</Badge> : null}
										{field.required ? <span className="sr-only">{t("forms.field.required")}</span> : null}
										{broken ? <span className="text-destructive text-xs">{t("forms.hasProblems")}</span> : null}
									</button>
									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button
													variant="ghost"
													size="icon"
													aria-label={t("forms.fieldActions", { label: field.label.text })}
												/>
											}
										>
											<EllipsisIcon />
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem
												disabled={index === 0}
												onClick={() => setFields(moveField(fields, index, -1), index - 1)}
											>
												<ArrowUpIcon />
												{t("forms.moveUp")}
											</DropdownMenuItem>
											<DropdownMenuItem
												disabled={index === fields.length - 1}
												onClick={() => setFields(moveField(fields, index, 1), index + 1)}
											>
												<ArrowDownIcon />
												{t("forms.moveDown")}
											</DropdownMenuItem>
											<DropdownMenuItem onClick={() => setFields(duplicateField(fields, index), index + 1)}>
												<CopyIcon />
												{t("forms.duplicate")}
											</DropdownMenuItem>
											<DropdownMenuItem
												variant="destructive"
												onClick={() =>
													setFields(
														fields.filter((_, at) => at !== index),
														Math.max(0, index - 1),
													)
												}
											>
												<TrashIcon />
												{t("forms.removeField")}
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</li>
							);
						})}
					</ol>
				)}
			</section>

			<section aria-labelledby="field-settings-heading" className="grid min-w-0 content-start gap-3">
				<h2 id="field-settings-heading" className="text-muted-foreground text-xs font-medium uppercase">
					{t("forms.fieldSettings")}
				</h2>
				{fields[current] ? (
					<FieldPanel
						key={current}
						field={fields[current]}
						onChange={(field) => setFields(fields.map((each, at) => (at === current ? field : each)))}
						problems={problems.filter((problem) => fieldIndexOf(problem) === current)}
						index={current}
						before={fields.slice(0, current)}
					/>
				) : (
					<p className="text-muted-foreground text-sm">{t("forms.selectField")}</p>
				)}
			</section>
		</div>
	);
}

/** How deep an item sits: inside a step (1), and inside a section of a step or of the Form (one more). */
function depthOf(fields: readonly FormVersion["fields"][number][], index: number): number {
	const item = fields[index];
	if (!item) return 0;
	let step = false;
	let section = false;
	for (const each of fields.slice(0, index)) {
		if (each.type === "step") {
			step = true;
			section = false;
		} else if (each.type === "section") section = true;
	}
	if (item.type === "step") return 0;
	if (item.type === "section") return step ? 1 : 0;
	return (step ? 1 : 0) + (section ? 1 : 0);
}
