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

import { getApi } from "../api.ts";
import { draftsOf, freeKey, inputsOf, keyFromLabel, newField } from "../content/field-drafts.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";

/**
 * What fixed text can become so clients edit it: a Prop of the Component (saved with it), a Field of
 * the Entry template's Post Type, or a Global (both apply at once: Post Types and the Globals have no
 * Draft). The text becomes the binding that reads it.
 */
export type FixedTextTarget = "prop" | "field" | "global";

/** What making fixed text editable did: the path its binding reads, and a Component's Props now. */
export type MadeEditable = { path: string; label: string; props?: FieldInput[] };

/**
 * "Make it a Prop" (in a Component), "Make it a Field" (in an Entry template) or "Make it a Global"
 * (in any other Template): a new one, named and keyed here, whose default (a Global: its Draft
 * value) is the fixed text, so nothing changes on the page; or one already there, of text or rich
 * text, whose value then shows instead.
 */
export function FixedTextDialog({
	open,
	onOpenChange,
	finalFocus,
	target,
	text,
	siteId,
	postTypeId,
	props,
	onMade,
}: {
	open: boolean;
	onOpenChange(open: boolean): void;
	finalFocus: RefObject<HTMLElement | null>;
	target: FixedTextTarget;
	text: string;
	siteId: string;
	postTypeId: string | null;
	/** A Component's Props as the builder has them. */
	props: FieldInput[] | null;
	onMade(made: MadeEditable): void;
}) {
	const t = useT();
	const id = useId();
	const [mode, setMode] = useState<"new" | "existing">("new");
	const [label, setLabel] = useState("");
	const [key, setKey] = useState("");
	const [existing, setExisting] = useState("");
	const [options, setOptions] = useState<{ key: string; label: string }[] | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const prefix = target === "prop" ? "props." : target === "global" ? "site." : "";

	// What is there already: text and rich text only (their values show where the fixed text was).
	const loadOptions = async () => {
		if (options) return;
		const editable = (fields: readonly { key: string; label: string; type: string }[]) =>
			fields.filter((field) => field.type === "text" || field.type === "richText");
		if (target === "prop") return setOptions(editable((props ?? []) as { key: string; label: string; type: string }[]));
		const api = await getApi();
		if (target === "global") return setOptions(editable((await api.globals.get({ siteId })).globals.fields));
		if (postTypeId) setOptions(editable((await api.postTypes.get({ siteId, postTypeId })).postType.fields));
	};

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setProblem(null);
		if (mode === "existing") {
			const chosen = options?.find((option) => option.key === existing);
			if (!chosen) return setProblem(t("builder.fixedText.chooseExisting"));
			onMade({ path: `${prefix}${chosen.key}`, label: chosen.label });
			return onOpenChange(false);
		}
		const finalKey = (key || keyFromLabel(label)).trim();
		if (!label.trim()) return setProblem(t("builder.fixedText.labelRequired"));
		if (!FIELD_KEY.test(finalKey)) return setProblem(t("builder.fixedText.keyInvalid"));
		const made = { ...newField("text", finalKey, label.trim()), default: text } as FieldInput;
		setBusy(true);
		try {
			if (target === "prop") {
				const current = props ?? [];
				if (current.some((prop) => prop.key === finalKey)) return setProblem(t("builder.fixedText.keyTaken"));
				onMade({ path: `props.${finalKey}`, label: made.label, props: [...current, made] });
				return onOpenChange(false);
			}
			const api = await getApi();
			if (target === "global") {
				const { globals } = await api.globals.get({ siteId });
				if (globals.fields.some((field) => field.key === finalKey)) return setProblem(t("builder.fixedText.keyTaken"));
				await api.globals.setFields({
					siteId,
					fields: [...inputsOf(draftsOf(globals.fields)), { ...made, default: null }],
				});
				await api.globals.saveDraft({ siteId, fields: { [finalKey]: text } });
			} else if (postTypeId) {
				const { postType } = await api.postTypes.get({ siteId, postTypeId });
				if (postType.fields.some((field) => field.key === finalKey)) return setProblem(t("builder.fixedText.keyTaken"));
				await api.postTypes.update({ siteId, postTypeId, fields: [...inputsOf(draftsOf(postType.fields)), made] });
			}
			onMade({ path: `${prefix}${finalKey}`, label: made.label });
			onOpenChange(false);
		} catch (failure) {
			const problems = (failure as { data?: { problems?: { message: string }[] } }).data?.problems;
			setProblem(problems?.length ? problems.map((each) => each.message).join(" ") : t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				onOpenChange(next);
				if (next) void loadOptions();
				else setProblem(null);
			}}
		>
			<DialogContent closeLabel={t("builder.fixedText.close")} finalFocus={finalFocus}>
				<form onSubmit={submit} className="grid gap-6" noValidate>
					<DialogHeader>
						<DialogTitle>{t(`builder.fixedText.make.${target}`)}</DialogTitle>
						<DialogDescription>{t(`builder.fixedText.intro.${target}`, { text })}</DialogDescription>
					</DialogHeader>
					<fieldset className="grid gap-2">
						<legend className="sr-only">{t(`builder.fixedText.make.${target}`)}</legend>
						{(["new", "existing"] as const).map((option) => (
							<div key={option} className="flex items-center gap-2">
								<input
									type="radio"
									id={`${id}-${option}`}
									name={`${id}-mode`}
									checked={mode === option}
									onChange={() => {
										setMode(option);
										if (option === "existing") void loadOptions();
									}}
									className="accent-primary size-4"
								/>
								<Label htmlFor={`${id}-${option}`}>{t(`builder.fixedText.mode.${option}.${target}`)}</Label>
							</div>
						))}
					</fieldset>
					{mode === "new" ? (
						<div className="grid gap-4">
							<Field>
								<FieldLabel htmlFor={`${id}-label`}>{t("builder.fixedText.label")}</FieldLabel>
								<Input
									id={`${id}-label`}
									value={label}
									onChange={(event) => {
										setLabel(event.target.value);
										setKey(freeKey(keyFromLabel(event.target.value), []));
									}}
									autoComplete="off"
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor={`${id}-key`}>{t("builder.fixedText.key")}</FieldLabel>
								<Input
									id={`${id}-key`}
									value={key}
									onChange={(event) => setKey(event.target.value)}
									className="font-mono"
									spellCheck={false}
									autoComplete="off"
									aria-describedby={`${id}-key-help`}
								/>
								<FieldDescription id={`${id}-key-help`}>
									{t("builder.fixedText.keyHelp", { binding: `{{ ${prefix}${key || "key"} }}` })}
								</FieldDescription>
							</Field>
						</div>
					) : (
						<Field>
							<FieldLabel htmlFor={`${id}-existing`}>{t(`builder.fixedText.existing.${target}`)}</FieldLabel>
							<NativeSelect
								id={`${id}-existing`}
								value={existing}
								onChange={(event) => setExisting(event.target.value)}
							>
								<NativeSelectOption value="">{t("builder.fixedText.none")}</NativeSelectOption>
								{(options ?? []).map((option) => (
									<NativeSelectOption key={option.key} value={option.key}>
										{`${option.label} (${prefix}${option.key})`}
									</NativeSelectOption>
								))}
							</NativeSelect>
						</Field>
					)}
					{problem ? <FieldError>{problem}</FieldError> : null}
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>
							{t("builder.fixedText.cancel")}
						</DialogClose>
						<Button type="submit" disabled={busy}>
							{t(`builder.fixedText.make.${target}`)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
