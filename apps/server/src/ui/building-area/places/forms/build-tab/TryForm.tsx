import { FORM_LIMITS, type FormField, isLayoutItem, uploadExtensions } from "@webcraft/renderer/forms";
import { formLogic } from "@webcraft/renderer/forms/logic";
import { type FormWords, ruleMessage } from "@webcraft/renderer/forms/words";
import { type FormEvent, type ReactNode, useMemo, useState } from "react";

import type { Words } from "../../../api.ts";
import { FieldView } from "./FormCanvas.tsx";
import { type FieldWidth, stepRange, stepsOf } from "./layout.ts";

const logic = formLogic();

const LIMITS = {
	textLength: FORM_LIMITS.textLength,
	textareaLength: FORM_LIMITS.textareaLength,
	options: FORM_LIMITS.options,
	defaultFileBytes: FORM_LIMITS.defaultFileBytes,
};

/** A pattern checked as the browser can: a whole-value match (the server checks it again on RE2). */
function matches(pattern: string, text: string): boolean {
	try {
		return new RegExp(`^(?:${pattern})$`, "u").test(text);
	} catch {
		return true;
	}
}

/**
 * Try it (SPEC 15.2, `forms-builder/03`): the Form filled in on its sheet, as a visitor would, with
 * its rules showing and hiding fields as they are answered, one step at a time with Back and Next,
 * and each step's errors as visitors see them. Nothing is sent: the button checks the last step and
 * shows the Form's message once sent, with a note that this was a try.
 */
export function TryForm({
	words,
	fields,
	formWords,
	submitLabel,
	sentMessage,
	step,
	onStep,
	announce,
}: {
	words: Words;
	fields: readonly FormField[];
	formWords: FormWords;
	submitLabel: string;
	/** What visitors read once it is sent (null when the Form goes on to a Page). */
	sentMessage: string | null;
	/** The step shown (from 1), which the step tabs above the sheet also change. */
	step: number;
	onStep(step: number): void;
	announce(text: string, urgent?: boolean): void;
}) {
	const [values, setValues] = useState<Record<string, string[]>>({});
	const [files, setFiles] = useState<Record<string, File[]>>({});
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [sent, setSent] = useState(false);
	const valuesOf = (key: string) => values[key] ?? [];
	const visible = useMemo(() => logic.visibleKeys(fields, (key) => values[key] ?? []), [fields, values]);
	const steps = stepsOf(fields);
	const count = Math.max(1, steps.length);

	/** The errors of the fields a step shows, as the forms script finds them before sending. */
	const check = (indexes: readonly number[]): Record<string, string> => {
		const found: Record<string, string> = {};
		for (const index of indexes) {
			const field = fields[index];
			if (!field || isLayoutItem(field) || field.type === "hidden" || !visible.has(field.key)) continue;
			const broken =
				field.type === "file"
					? logic.checkFiles(
							field,
							(files[field.key] ?? []).map((file) => ({ name: file.name, size: file.size })),
							uploadExtensions(field.accept),
							LIMITS,
						)
					: logic.readValue(field, valuesOf(field.key), LIMITS, matches).broken;
			if (broken) found[field.key] = field.message?.text ?? ruleMessage(formWords, broken.rule, broken.params);
		}
		return found;
	};

	const { indexes } = stepRange(fields, step);
	const go = (event: FormEvent | null, next: number) => {
		event?.preventDefault();
		if (next > step) {
			const found = check(indexes);
			setErrors(found);
			const problems = Object.keys(found).length;
			if (problems > 0) {
				announce(problems === 1 ? formWords.problem : formWords.problems.replace("{count}", String(problems)), true);
				return;
			}
		}
		if (next > count) {
			setSent(true);
			announce(words.forms.tryIt.notSent);
			return;
		}
		setErrors({});
		onStep(next);
	};

	if (sent) {
		return (
			<div className="wc-form-sent" role="status">
				{sentMessage ? <p>{sentMessage}</p> : null}
				<p data-wcb-note="">{words.forms.tryIt.notSent}</p>
				<p>
					<button
						type="button"
						className="wc-form-back"
						onClick={() => {
							setSent(false);
							setValues({});
							setFiles({});
							onStep(1);
						}}
					>
						{words.forms.tryIt.again}
					</button>
				</p>
			</div>
		);
	}

	const drawn: ReactNode[] = [];
	let section: { field: FormField; children: ReactNode[] } | null = null;
	const close = () => {
		if (!section) return;
		const { field, children } = section;
		drawn.push(
			<fieldset key={`section-${field.key}`} className="wc-form-section">
				<legend className={field.hideLabel ? "wc-visually-hidden" : undefined}>{field.label.text}</legend>
				{field.help ? <p className="wc-form-help">{field.help.text}</p> : null}
				{children}
			</fieldset>,
		);
		section = null;
	};
	for (const index of indexes) {
		const field = fields[index];
		if (!field || field.type === "hidden" || !visible.has(field.key)) continue;
		if (field.type === "section") {
			close();
			section = { field, children: [] };
			continue;
		}
		const view = (
			<FieldView
				key={field.key}
				field={field}
				width={(field.width as FieldWidth | null) ?? "whole"}
				words={formWords}
				trying={{
					values: valuesOf(field.key),
					error: errors[field.key] ?? null,
					onValue: (next) => setValues((was) => ({ ...was, [field.key]: next })),
					onFiles: (next) => setFiles((was) => ({ ...was, [field.key]: next })),
				}}
			/>
		);
		if (section) section.children.push(view);
		else drawn.push(view);
	}
	close();

	const last = step >= count;
	return (
		<form className="wc-form" noValidate onSubmit={(event) => go(event, step + 1)} data-wcb-trying="">
			{indexes.some((index) => fields[index]?.required) ? <p className="wc-form-note">{formWords.required}</p> : null}
			{drawn}
			{steps.length > 0 ? (
				<div className="wc-form-step-nav">
					{step > 1 ? (
						<button type="button" className="wc-form-back" onClick={() => go(null, step - 1)}>
							{formWords.back}
						</button>
					) : null}
					{last ? null : (
						<button type="submit" className="wc-form-next">
							{formWords.next}
						</button>
					)}
				</div>
			) : null}
			{last ? (
				<button type="submit" className="wc-form-submit">
					{submitLabel}
				</button>
			) : null}
		</form>
	);
}
