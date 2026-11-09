import { Badge } from "@webcraft/ui/components/badge.tsx";
import { Button } from "@webcraft/ui/components/button.tsx";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { XIcon } from "lucide-react";
import { useRef } from "react";

import { useT } from "../i18n.tsx";
import type { FieldDefinition } from "./model.ts";

/** An Entry a Relationship can point at. */
export type LinkableEntry = { id: string; title: string; status: "draft" | "published" | "changed" };

/** The Entries a Relationship can point at, by their Post Type's key. */
export type RelationshipTargets = Readonly<
	Record<string, { name: string; entries: readonly LinkableEntry[] } | undefined>
>;

type RelationshipField = Extract<FieldDefinition, { type: "relationship" }>;

/**
 * A Relationship's control: the Entries it points at, each with a Remove button, and a list of the
 * Entries it can point at (by Post Type) to add one. A Relationship holding one Entry is a single list.
 */
export function RelationshipPicker({
	id,
	labelledBy,
	describedBy,
	invalid,
	field,
	value,
	targets,
	onChange,
}: {
	id: string;
	labelledBy: string;
	describedBy?: string;
	invalid?: boolean;
	field: RelationshipField;
	value: string | string[] | null;
	targets: RelationshipTargets;
	onChange(next: string | string[] | null): void;
}) {
	const t = useT();
	const adder = useRef<HTMLSelectElement>(null);
	const groups = field.postTypes.flatMap((key) => {
		const target = targets[key];
		return target ? [{ key, ...target }] : [];
	});
	const known = new Map(groups.flatMap((group) => group.entries.map((entry) => [entry.id, entry] as const)));
	const chosen = Array.isArray(value) ? value : value ? [value] : [];

	const options = (exclude: readonly string[]) =>
		groups.map((group) => (
			<NativeSelectOptGroup key={group.key} label={group.name}>
				{group.entries
					.filter((entry) => !exclude.includes(entry.id))
					.map((entry) => (
						<NativeSelectOption key={entry.id} value={entry.id}>
							{entry.title || t("content.relationship.untitled")}
						</NativeSelectOption>
					))}
			</NativeSelectOptGroup>
		));

	if (!field.multiple) {
		return (
			<NativeSelect
				id={id}
				value={chosen[0] ?? ""}
				aria-labelledby={labelledBy}
				aria-describedby={describedBy}
				aria-invalid={invalid ? true : undefined}
				onChange={(event) => onChange(event.target.value || null)}
				className="w-full"
			>
				<NativeSelectOption value="">{t("content.relationship.none")}</NativeSelectOption>
				{chosen[0] && !known.has(chosen[0]) ? (
					<NativeSelectOption value={chosen[0]}>{t("content.relationship.unknown")}</NativeSelectOption>
				) : null}
				{options([])}
			</NativeSelect>
		);
	}

	const atMost = field.max !== null && chosen.length >= field.max;
	return (
		<div className="grid gap-3">
			{chosen.length > 0 ? (
				<ul aria-labelledby={labelledBy} className="flex flex-wrap gap-2">
					{chosen.map((entryId) => {
						const entry = known.get(entryId);
						const title = entry ? entry.title || t("content.relationship.untitled") : t("content.relationship.unknown");
						return (
							<li key={entryId} className="bg-muted flex items-center gap-2 rounded-full py-1 ps-3 pe-1 text-sm">
								<span>{title}</span>
								{entry && entry.status === "draft" ? (
									<Badge variant="outline">{t("entries.status.draft")}</Badge>
								) : null}
								<Button
									type="button"
									variant="ghost"
									size="icon-xs"
									aria-label={t("content.relationship.remove", { title })}
									onClick={() => {
										onChange(chosen.filter((other) => other !== entryId));
										adder.current?.focus();
									}}
								>
									<XIcon aria-hidden="true" />
								</Button>
							</li>
						);
					})}
				</ul>
			) : null}
			<NativeSelect
				ref={adder}
				id={id}
				value=""
				disabled={atMost}
				aria-labelledby={`${id}-add-label ${labelledBy}`}
				aria-describedby={describedBy}
				aria-invalid={invalid ? true : undefined}
				onChange={(event) => {
					if (event.target.value) onChange([...chosen, event.target.value]);
				}}
				className="w-full"
			>
				<NativeSelectOption value="">{t("content.relationship.add")}</NativeSelectOption>
				{options(chosen)}
			</NativeSelect>
			<span id={`${id}-add-label`} className="sr-only">
				{t("content.relationship.addTo")}
			</span>
		</div>
	);
}
