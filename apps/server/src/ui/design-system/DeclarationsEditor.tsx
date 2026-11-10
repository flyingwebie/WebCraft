import { Button } from "@webcraft/ui/components/button.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { XIcon } from "lucide-react";
import { useId, useState } from "react";

import { useT } from "../i18n.tsx";
import { cssOf, type Declaration, declarationsOf, PROPERTIES } from "./declarations.ts";
import { type Tokens, tokenValuesFor } from "./model.ts";
import { useFollowsExternal } from "./useFollowsExternal.ts";

/** The rows `css` reads as, with a blank one at the end ready to fill in. */
function rowsOf(css: string): Declaration[] {
	return [...declarationsOf(css), { property: "", value: "" }];
}

/**
 * CSS declarations edited as rows of a property and a value, token values first: each value offers
 * the Design tokens that fit its property (colours for `color`, spacing steps for `padding`, type
 * steps for `font-size`, …), and any other value can still be typed where CSS takes it. Every change
 * hands the declarations back as text; the server checks them when it saves. `css` is followed when
 * it changes from outside (the Draft replaced by an import), without losing a row being typed.
 */
export function DeclarationsEditor({
	label,
	css,
	tokens,
	onChange,
	describedBy,
}: {
	/** What the declarations are, said with each row's fields ("Styles for every width"). */
	label: string;
	css: string;
	tokens: Tokens;
	onChange(css: string): void;
	describedBy?: string;
}) {
	const t = useT();
	const id = useId();
	const [rows, setRows] = useState<Declaration[]>(() => rowsOf(css));
	const stamp = useFollowsExternal(css, (next) => setRows(rowsOf(next)));

	const update = (next: Declaration[]) => {
		const last = next.at(-1);
		const withBlank = !last || last.property || last.value ? [...next, { property: "", value: "" }] : next;
		setRows(withBlank);
		const nextCss = cssOf(withBlank);
		stamp(nextCss);
		onChange(nextCss);
	};

	return (
		<fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0" aria-describedby={describedBy}>
			<legend className="mb-1 text-sm font-medium">{label}</legend>
			<datalist id={`${id}-properties`}>
				{PROPERTIES.map((property) => (
					<option key={property} value={property} />
				))}
			</datalist>
			<ol className="grid gap-2">
				{rows.map((row, index) => {
					const suggestions = tokenValuesFor(row.property, tokens);
					return (
						// Rows have no identity of their own besides where they are.
						// biome-ignore lint/suspicious/noArrayIndexKey: declarations are edited in place.
						<li key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2">
							<Input
								aria-label={t("designSystem.declarations.property", { what: label, number: index + 1 })}
								list={`${id}-properties`}
								value={row.property}
								onChange={(event) =>
									update(rows.map((each, at) => (at === index ? { ...each, property: event.target.value } : each)))
								}
								className="font-mono text-xs"
								spellCheck={false}
								autoComplete="off"
							/>
							<Input
								aria-label={t("designSystem.declarations.value", { what: label, number: index + 1 })}
								list={suggestions.length > 0 ? `${id}-values-${index}` : undefined}
								value={row.value}
								onChange={(event) =>
									update(rows.map((each, at) => (at === index ? { ...each, value: event.target.value } : each)))
								}
								className="font-mono text-xs"
								spellCheck={false}
								autoComplete="off"
							/>
							{suggestions.length > 0 ? (
								<datalist id={`${id}-values-${index}`}>
									{suggestions.map((value) => (
										<option key={value} value={value} />
									))}
								</datalist>
							) : null}
							{row.property || row.value ? (
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label={t("designSystem.declarations.remove", { what: label, number: index + 1 })}
									onClick={() => update(rows.filter((_, at) => at !== index))}
								>
									<XIcon aria-hidden="true" />
								</Button>
							) : (
								<span className="size-7" />
							)}
						</li>
					);
				})}
			</ol>
		</fieldset>
	);
}
