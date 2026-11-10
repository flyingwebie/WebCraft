import { Field, FieldDescription, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { useId, useState } from "react";

import { useT } from "../i18n.tsx";
import { DeclarationsEditor } from "./DeclarationsEditor.tsx";
import type { Editing } from "./DesignSystemScreen.tsx";
import { html } from "./model.ts";
import { StylePreview } from "./StylePreview.tsx";

/** A page of the plain elements base styles style, to preview them and the Site's custom CSS on. */
function samplePage(t: ReturnType<typeof useT>): string {
	const words = (key: Parameters<typeof t>[0]) => html(t(key));
	return [
		`<h1>${words("designSystem.sample.h1")}</h1>`,
		`<h2>${words("designSystem.sample.h2")}</h2>`,
		`<p>${words("designSystem.sample.paragraph")} <a href="#">${words("designSystem.sample.link")}</a> <mark>${words("designSystem.sample.mark")}</mark> <code>code</code> <small>${words("designSystem.sample.small")}</small></p>`,
		`<h3>${words("designSystem.sample.h3")}</h3>`,
		`<ul><li>${words("designSystem.sample.item")}</li><li>${words("designSystem.sample.item")}</li></ul>`,
		`<blockquote><p>${words("designSystem.sample.quote")}</p></blockquote>`,
		`<nav><a href="#">${words("designSystem.sample.link")}</a></nav>`,
		"<hr>",
		`<table><thead><tr><th>${words("designSystem.sample.th")}</th><th>${words("designSystem.sample.th")}</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>`,
		`<figure><figcaption>${words("designSystem.sample.caption")}</figcaption></figure>`,
		`<pre>${words("designSystem.sample.pre")}</pre>`,
	].join("");
}

/**
 * The Base styles tab: the declarations each plain element starts with (from the Design tokens),
 * one element at a time, token values first, beside a preview page of every element.
 */
export function BaseStylesTab({ editing }: { editing: Editing }) {
	const t = useT();
	const id = useId();
	const targets = editing.preview.baseTargets;
	const [target, setTarget] = useState(targets[0] ?? "body");
	const { baseStyles, tokens } = editing.draft;
	return (
		<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
			<div className="grid content-start gap-4">
				<p className="text-muted-foreground text-sm">{t("designSystem.base.intro")}</p>
				<Field>
					<FieldLabel htmlFor={`${id}-target`}>{t("designSystem.base.element")}</FieldLabel>
					<NativeSelect id={`${id}-target`} value={target} onChange={(event) => setTarget(event.target.value)}>
						{targets.map((each) => (
							<NativeSelectOption key={each} value={each}>
								{each}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
				<DeclarationsEditor
					key={target}
					label={t("designSystem.base.styles", { element: target })}
					css={baseStyles[target] ?? ""}
					tokens={tokens}
					onChange={(css) => {
						const next = { ...editing.draft.baseStyles, [target]: css };
						if (!css) delete next[target];
						editing.setSection("baseStyles", next);
					}}
				/>
			</div>
			<StylePreview
				title={t("designSystem.base.previewTitle")}
				stylesheet={editing.preview.stylesheet}
				markup={samplePage(t)}
				mode={editing.mode}
			/>
		</div>
	);
}

/**
 * The Custom CSS tab: the Site's own CSS, in the stylesheet's last layer (`custom`), so it never
 * needs `!important`; checked as it is saved, each problem with its line and column.
 */
export function CustomCssTab({ editing }: { editing: Editing }) {
	const t = useT();
	const id = useId();
	return (
		<div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
			<Field>
				<FieldLabel htmlFor={`${id}-css`}>{t("designSystem.css.label")}</FieldLabel>
				<Textarea
					id={`${id}-css`}
					value={editing.draft.customCss}
					onChange={(event) => editing.setSection("customCss", event.target.value)}
					className="min-h-80 font-mono text-xs"
					spellCheck={false}
					aria-describedby={`${id}-css-help`}
				/>
				<FieldDescription id={`${id}-css-help`}>{t("designSystem.css.help")}</FieldDescription>
			</Field>
			<StylePreview
				title={t("designSystem.css.previewTitle")}
				stylesheet={editing.preview.stylesheet}
				markup={samplePage(t)}
				mode={editing.mode}
			/>
		</div>
	);
}
