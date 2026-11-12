import { FIELD_KEY } from "@webcraft/core/field-rules";
import { fixedTextsOf, type TreeNode } from "@webcraft/renderer/builder";
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
import { type FormEvent, type RefObject, useId, useMemo, useState } from "react";

import { keyFromLabel } from "../content/field-drafts.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { excerpt } from "./model.ts";

/** What the name prompt asks for: Make Component (with the node it moves) or New Component. */
export type ComponentPrompt = { mode: "make"; node: TreeNode; name: string } | { mode: "new"; placed: boolean };

/** What the prompt answers: the name, and for Make Component the fixed text to turn into Props. */
export type ComponentChoice = { name: string; texts: { index: number; key: string }[] };

/** A Component's name: a PascalCase tag (a capital first, then letters and digits, at least one lower-case). */
const COMPONENT_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;

/** A name from what the element is called: `Opening hours` gives `OpeningHours`. */
export function componentNameFrom(label: string): string {
	const words = label
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1));
	const name = words.join("").replace(/^[0-9]+/, "");
	return COMPONENT_NAME.test(name) && /[a-z]/.test(name) ? name : "";
}

/** The key a piece of fixed text's Prop starts with, from what holds it. */
function suggestedKey(text: string, taken: Set<string>): string {
	const stem = keyFromLabel(text.split(/\s+/).slice(0, 3).join(" ")) || "text";
	let base = stem.replaceAll(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
	if (!FIELD_KEY.test(base)) base = "text";
	// `heading`, `heading_2`, …: as the Field builder numbers a key already taken.
	let key = base;
	for (let count = 2; taken.has(key); count++) key = `${base}_${count}`;
	taken.add(key);
	return key;
}

/**
 * The name prompt Make Component and New Component share (#121): a unique PascalCase name and, for
 * Make Component, "Turn the fixed text into a Prop" for each piece of text in what moves, the text
 * then the Prop's default. The server checks the name (taken, reserved) and answers why not; the
 * dialog stays open with the reason.
 */
export function ComponentDialog({
	prompt,
	onClose,
	finalFocus,
	onSubmit,
}: {
	prompt: ComponentPrompt | null;
	onClose(): void;
	finalFocus?: RefObject<HTMLElement | null>;
	/** Makes the Component; answers why not, or undefined once it is made (the dialog then closes). */
	onSubmit(choice: ComponentChoice): Promise<string | undefined>;
}) {
	const t = useT();
	return (
		<Dialog
			open={prompt !== null}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<DialogContent closeLabel={t("builder.components.cancel")} finalFocus={finalFocus}>
				{prompt ? (
					<PromptForm
						key={prompt.mode === "make" ? JSON.stringify(prompt.node) : "new"}
						prompt={prompt}
						onSubmit={onSubmit}
						onDone={onClose}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function PromptForm({
	prompt,
	onSubmit,
	onDone,
}: {
	prompt: ComponentPrompt;
	onSubmit(choice: ComponentChoice): Promise<string | undefined>;
	onDone(): void;
}) {
	const t = useT();
	const id = useId();
	const [name, setName] = useState(prompt.mode === "make" ? prompt.name : "");
	const texts = useMemo(() => (prompt.mode === "make" ? fixedTextsOf(prompt.node) : []), [prompt]);
	const [chosen, setChosen] = useState<Map<number, string>>(new Map());
	const suggestions = useMemo(() => {
		const taken = new Set<string>();
		return texts.map((text) => suggestedKey(text.text.trim(), taken));
	}, [texts]);
	const [problem, setProblem] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const title = prompt.mode === "make" ? t("builder.components.makeTitle") : t("builder.components.newTitle");

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setProblem(null);
		const wanted = name.trim();
		if (!COMPONENT_NAME.test(wanted) || !/[a-z]/.test(wanted)) return setProblem(t("builder.components.nameInvalid"));
		const picked = [...chosen].map(([index, key]) => ({ index, key: key.trim() }));
		const keys = new Set<string>();
		for (const each of picked) {
			if (!FIELD_KEY.test(each.key)) return setProblem(t("builder.components.keyInvalid", { key: each.key }));
			if (keys.has(each.key.toLowerCase())) return setProblem(t("builder.components.keyTwice", { key: each.key }));
			keys.add(each.key.toLowerCase());
		}
		setBusy(true);
		try {
			const refused = await onSubmit({ name: wanted, texts: picked });
			if (refused) setProblem(refused);
			else onDone();
		} catch (failure) {
			setProblem(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<form onSubmit={submit} className="grid gap-6" noValidate>
			<DialogHeader>
				<DialogTitle>{title}</DialogTitle>
				<DialogDescription>
					{prompt.mode === "make"
						? t("builder.components.makeIntro")
						: prompt.placed
							? t("builder.components.newPlacedIntro")
							: t("builder.components.newIntro")}
				</DialogDescription>
			</DialogHeader>
			<Field data-invalid={problem ? true : undefined}>
				<FieldLabel htmlFor={`${id}-name`}>{t("builder.components.name")}</FieldLabel>
				<Input
					id={`${id}-name`}
					value={name}
					onChange={(event) => setName(event.target.value)}
					className="font-mono"
					spellCheck={false}
					autoComplete="off"
					aria-invalid={problem ? true : undefined}
					aria-describedby={`${id}-name-help${problem ? ` ${id}-problem` : ""}`}
				/>
				<FieldDescription id={`${id}-name-help`}>{t("builder.components.nameHelp")}</FieldDescription>
			</Field>
			{texts.length > 0 ? (
				<fieldset className="grid gap-3">
					<legend className="mb-1 text-sm font-medium">{t("builder.components.texts")}</legend>
					<p className="text-muted-foreground text-xs">{t("builder.components.textsHelp")}</p>
					<ul className="grid max-h-64 gap-3 overflow-auto">
						{texts.map((text, index) => {
							const key = chosen.get(index);
							return (
								// biome-ignore lint/suspicious/noArrayIndexKey: a piece of text is where it is in the selection.
								<li key={index} className="grid gap-2 rounded-md border p-2">
									<label className="flex items-start gap-2 text-sm">
										<input
											type="checkbox"
											className="accent-primary mt-0.5 size-4"
											checked={key !== undefined}
											onChange={(event) =>
												setChosen((before) => {
													const next = new Map(before);
													if (event.target.checked) next.set(index, suggestions[index] ?? "text");
													else next.delete(index);
													return next;
												})
											}
										/>
										<span>
											{t("builder.components.turnIntoProp")}
											<span className="text-muted-foreground block">“{excerpt(text.text.trim(), 60)}”</span>
										</span>
									</label>
									{key !== undefined ? (
										<Field>
											<FieldLabel htmlFor={`${id}-key-${index}`}>{t("builder.components.propKey")}</FieldLabel>
											<Input
												id={`${id}-key-${index}`}
												value={key}
												onChange={(event) => setChosen((before) => new Map(before).set(index, event.target.value))}
												className="font-mono"
												spellCheck={false}
												autoComplete="off"
											/>
										</Field>
									) : null}
								</li>
							);
						})}
					</ul>
				</fieldset>
			) : null}
			{problem ? (
				<FieldError id={`${id}-problem`} role="alert">
					{problem}
				</FieldError>
			) : null}
			<DialogFooter>
				<DialogClose render={<Button variant="outline" type="button" />}>{t("builder.components.cancel")}</DialogClose>
				<Button type="submit" disabled={busy}>
					{prompt.mode === "make" ? t("builder.components.make") : t("builder.components.create")}
				</Button>
			</DialogFooter>
		</form>
	);
}

/** The words of a refusal from Make Component or New Component: the name taken, else problem by problem. */
export function componentRefusal(failure: unknown, t: ReturnType<typeof useT>): string {
	const { code, data } = failure as { code?: string; data?: { name?: string; problems?: { message: string }[] } };
	if (code === "COMPONENT_NAME_TAKEN") return t("builder.components.nameTaken", { name: data?.name ?? "" });
	return data?.problems?.length ? data.problems.map((each) => each.message).join(" ") : t(errorMessage(failure));
}
