import type { FieldInput } from "@webcraft/core";
import { FIELD_KEY } from "@webcraft/core/field-rules";
import { Button } from "@webcraft/ui/components/button.tsx";
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
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { type FormEvent, type RefObject, useId, useState } from "react";

import { freeKey, keyFromLabel, newField } from "../content/field-drafts.ts";
import { useT } from "../i18n.tsx";

/** What a setting binds to: a link's address (a Link Prop's `url`) or an image's file (a Media Prop). */
export type BindKind = "link" | "media";

/** What Bind to Prop chose: the binding written into the markup and, for a new Prop, the Props now. */
export type Bound = { path: string; props?: FieldInput[] };

/** The binding a Prop of the kind is read with. */
export function bindingPath(kind: BindKind, key: string): string {
	return kind === "link" ? `props.${key}.url` : `props.${key}`;
}

/**
 * Bind to Prop (#134) for a link's address or an image's file: a Prop the Component has, of the
 * matching Field type, or a new one whose default is what the setting holds now (a link's address,
 * an image's `media:<id>`), so nothing changes until a Placement gives another. `{{ props.x }}` is
 * then written into the markup: one representation.
 */
export function BindPropDialog({
	open,
	onOpenChange,
	finalFocus,
	kind,
	current,
	props,
	onBound,
}: {
	open: boolean;
	onOpenChange(open: boolean): void;
	finalFocus: RefObject<HTMLElement | null>;
	kind: BindKind;
	/** What the setting holds now, as fixed text (empty when it already reads a value). */
	current: string;
	props: readonly FieldInput[];
	/** Applies the binding; answers why not. */
	onBound(bound: Bound): string | undefined;
}) {
	const t = useT();
	const id = useId();
	const matching = props.filter((prop) => prop.type === kind);
	const [mode, setMode] = useState<"new" | "existing">(matching.length ? "existing" : "new");
	const [existing, setExisting] = useState(matching[0]?.key ?? "");
	const [label, setLabel] = useState(kind === "link" ? t("builder.bind.linkLabel") : t("builder.bind.imageLabel"));
	const [key, setKey] = useState(() =>
		freeKey(
			keyFromLabel(kind === "link" ? "link" : "image"),
			props.map((prop) => ({ uid: prop.key, saved: true, field: prop as never, children: [] })),
		),
	);
	const [problem, setProblem] = useState<string | null>(null);
	const finish = (bound: Bound) => {
		const refused = onBound(bound);
		if (refused) setProblem(refused);
		else onOpenChange(false);
	};
	const submit = (event: FormEvent) => {
		event.preventDefault();
		setProblem(null);
		if (mode === "existing") {
			if (!existing) return setProblem(t("builder.bind.choose"));
			return finish({ path: bindingPath(kind, existing) });
		}
		const finalKey = key.trim();
		if (!label.trim()) return setProblem(t("builder.fixedText.labelRequired"));
		if (!FIELD_KEY.test(finalKey)) return setProblem(t("builder.fixedText.keyInvalid"));
		if (props.some((prop) => prop.key.toLowerCase() === finalKey.toLowerCase()))
			return setProblem(t("builder.fixedText.keyTaken"));
		const fixed = current.trim();
		const media = /^media:(.+)$/i.exec(fixed)?.[1];
		const fallback = kind === "link" ? (fixed ? { url: fixed, text: "" } : null) : (media ?? null);
		const made = { ...newField(kind, finalKey, label.trim()), default: fallback } as FieldInput;
		finish({ path: bindingPath(kind, finalKey), props: [...props, made] });
	};
	const title = kind === "link" ? t("builder.bind.linkTitle") : t("builder.bind.imageTitle");
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent closeLabel={t("builder.fixedText.close")} finalFocus={finalFocus}>
				<form onSubmit={submit} className="grid gap-6" noValidate>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>
							{kind === "link" ? t("builder.bind.linkIntro") : t("builder.bind.imageIntro")}
						</DialogDescription>
					</DialogHeader>
					<fieldset className="grid gap-2">
						<legend className="sr-only">{title}</legend>
						{(["existing", "new"] as const).map((option) => (
							<div key={option} className="flex items-center gap-2">
								<input
									type="radio"
									id={`${id}-${option}`}
									name={`${id}-mode`}
									checked={mode === option}
									disabled={option === "existing" && matching.length === 0}
									onChange={() => setMode(option)}
									className="accent-primary size-4"
								/>
								<Label htmlFor={`${id}-${option}`}>{t(`builder.fixedText.mode.${option}.prop`)}</Label>
							</div>
						))}
					</fieldset>
					{mode === "existing" ? (
						<Field>
							<FieldLabel htmlFor={`${id}-existing`}>{t("builder.fixedText.existing.prop")}</FieldLabel>
							<NativeSelect
								id={`${id}-existing`}
								value={existing}
								onChange={(event) => setExisting(event.target.value)}
							>
								{matching.map((prop) => (
									<NativeSelectOption key={prop.key} value={prop.key}>
										{`${prop.label} (${bindingPath(kind, prop.key)})`}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</Field>
					) : (
						<div className="grid gap-4">
							<Field>
								<FieldLabel htmlFor={`${id}-label`}>{t("builder.fixedText.label")}</FieldLabel>
								<Input
									id={`${id}-label`}
									value={label}
									autoComplete="off"
									onChange={(event) => {
										setLabel(event.target.value);
										setKey(keyFromLabel(event.target.value));
									}}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor={`${id}-key`}>{t("builder.fixedText.key")}</FieldLabel>
								<Input
									id={`${id}-key`}
									value={key}
									className="font-mono"
									spellCheck={false}
									autoComplete="off"
									aria-describedby={`${id}-key-help`}
									onChange={(event) => setKey(event.target.value)}
								/>
								<FieldDescription id={`${id}-key-help`}>
									{t("builder.fixedText.keyHelp", { binding: `{{ ${bindingPath(kind, key || "key")} }}` })}
								</FieldDescription>
							</Field>
						</div>
					)}
					{problem ? <FieldError role="alert">{problem}</FieldError> : null}
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>
							{t("builder.fixedText.cancel")}
						</DialogClose>
						<Button type="submit">{t("builder.bind.button")}</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
