import type { ApiClient } from "@webcraft/api";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { NativeSelect, NativeSelectOption } from "@webcraft/ui/components/native-select.tsx";
import { CopyIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { errorMessage } from "../errors.ts";
import { type MessageKey, useT } from "../i18n.tsx";
import { languageName } from "./DraftParts.tsx";

/** What a Data tab shows: a real item's values from the Draft and the bindings that read them. */
export type DataSampleView = Awaited<ReturnType<ApiClient["loops"]["data"]>>;

/**
 * The Data tab (Staff only): a real item's values from the Draft as JSON, in a language of the Site,
 * and the bindings Template markup writes to read each one, each with a Copy button that works from
 * the keyboard and says what it copied.
 */
export function DataTab({
	load,
	languages,
	intro,
}: {
	/** Reads the sample in a language. */
	load(language: string): Promise<DataSampleView>;
	languages: { default: string; all: readonly string[] };
	intro: MessageKey;
}) {
	const t = useT();
	const ids = useId();
	const [language, setLanguage] = useState(languages.default);
	const [sample, setSample] = useState<DataSampleView | null>(null);
	const [failure, setFailure] = useState<MessageKey | null>(null);
	const [copied, setCopied] = useState("");

	useEffect(() => {
		let current = true;
		setFailure(null);
		load(language).then(
			(loaded) => {
				if (current) setSample(loaded);
			},
			(error: unknown) => {
				if (current) setFailure(errorMessage(error));
			},
		);
		return () => {
			current = false;
		};
	}, [language, load]);

	const copy = async (binding: string) => {
		const done = await copyText(binding);
		setCopied(done ? t("data.copied", { binding }) : t("data.copyFailed", { binding }));
	};

	return (
		<div className="grid gap-6">
			<p className="text-muted-foreground text-sm">{t(intro)}</p>
			{languages.all.length > 1 ? (
				<div className="grid max-w-xs gap-2">
					<Label htmlFor={`${ids}-language`}>{t("data.language")}</Label>
					<NativeSelect id={`${ids}-language`} value={language} onChange={(event) => setLanguage(event.target.value)}>
						{languages.all.map((code) => (
							<NativeSelectOption key={code} value={code}>
								{languageName(code)}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>
			) : null}
			{failure ? (
				<p role="alert" className="text-destructive text-sm">
					{t(failure)}
				</p>
			) : null}
			{sample ? (
				<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
					<section aria-labelledby={`${ids}-item`} className="grid min-w-0 content-start gap-2">
						<h2 id={`${ids}-item`} className="font-semibold">
							{sample.item ? t("data.itemHeading", { label: sample.item.label }) : t("data.noItemHeading")}
						</h2>
						{sample.item ? (
							// Read-only text: reached from the keyboard, scrolled, selected and copied whole.
							<textarea
								readOnly
								aria-labelledby={`${ids}-item`}
								rows={18}
								spellCheck={false}
								value={JSON.stringify(sample.item.values, null, 2)}
								className="bg-muted focus-visible:ring-ring/50 w-full resize-y rounded-md border p-4 font-mono text-xs leading-relaxed outline-none focus-visible:ring-3"
							/>
						) : (
							<p className="text-muted-foreground text-sm">{t("data.noItem")}</p>
						)}
					</section>
					<section aria-labelledby={`${ids}-bindings`} className="grid min-w-0 content-start gap-2">
						<h2 id={`${ids}-bindings`} className="font-semibold">
							{t("data.bindingsHeading")}
						</h2>
						<ul className="divide-y rounded-md border">
							{sample.bindings.map((binding) => (
								<li key={binding.binding} className="flex items-center gap-3 px-3 py-2">
									<code className="min-w-0 flex-1 truncate font-mono text-xs">{binding.binding}</code>
									{binding.label ? (
										<span className="text-muted-foreground hidden truncate text-xs sm:inline">{binding.label}</span>
									) : null}
									<Button
										type="button"
										size="sm"
										variant="outline"
										aria-label={t("data.copy", { binding: binding.binding })}
										onClick={() => void copy(binding.binding)}
									>
										<CopyIcon aria-hidden="true" />
										{t("data.copyShort")}
									</Button>
								</li>
							))}
						</ul>
						<p role="status" className="text-muted-foreground min-h-5 text-sm">
							{copied}
						</p>
					</section>
				</div>
			) : null}
		</div>
	);
}

/**
 * Puts text on the clipboard: through the Clipboard API where the browser allows it, else through a
 * selected text area and the copy command. Answers whether it worked.
 */
async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.className = "fixed -start-[9999px] top-0";
		const focused = document.activeElement as HTMLElement | null;
		document.body.append(area);
		area.select();
		let done = false;
		try {
			done = document.execCommand("copy");
		} catch {
			done = false;
		}
		area.remove();
		focused?.focus();
		return done;
	}
}
