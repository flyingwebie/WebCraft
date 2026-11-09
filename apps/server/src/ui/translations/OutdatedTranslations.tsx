import { useRouter } from "@tanstack/react-router";
import type { ItemTranslation } from "@webcraft/core";
import { Button } from "@webcraft/ui/components/button.tsx";
import { CheckIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";

/**
 * An Entry's Outdated translations in the language its editor shows: values a person wrote whose
 * Default-language source changed since, each next to its old and its new source, until someone
 * updates the translation, confirms it, or has the AI translate it again.
 */
export function OutdatedTranslations({
	siteId,
	entryId,
	language,
	translation,
	beforeChange,
}: {
	siteId: string;
	entryId: string;
	language: string;
	translation: ItemTranslation | null;
	/** Runs first: the editor saves what is waiting, so nothing typed is lost. */
	beforeChange: () => Promise<unknown>;
}) {
	const t = useT();
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	if (!translation || translation.outdated.length === 0) return null;
	const act = async (action: "confirm" | "retranslate", at: string, block: string | null) => {
		setBusy(true);
		try {
			await beforeChange();
			const api = await getApi();
			const input = { siteId, item: { kind: "entry" as const, id: entryId }, language, at, block };
			if (action === "confirm") await api.translations.confirm(input);
			else await api.translations.retranslate(input);
			toast.success(action === "confirm" ? t("translations.confirmed") : t("translations.retranslated"));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<section
			aria-labelledby="outdated-translations-heading"
			className="grid gap-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
		>
			<h2 id="outdated-translations-heading" className="flex items-center gap-2 font-semibold">
				<TriangleAlertIcon className="size-4" aria-hidden="true" />
				{t("translations.editor.heading", { count: translation.outdated.length })}
			</h2>
			<p className="text-sm">{t("translations.editor.intro")}</p>
			<ul className="grid gap-4">
				{translation.outdated.map((outdated) => (
					<li
						key={`${outdated.at}#${outdated.block ?? ""}`}
						className="bg-background text-foreground grid gap-3 rounded-md border p-3"
					>
						<p className="font-medium">{outdated.labels.join(" › ")}</p>
						<dl className="grid gap-2 text-sm md:grid-cols-3">
							<div>
								<dt className="text-muted-foreground">{t("translations.queue.oldSource")}</dt>
								<dd className="whitespace-pre-line line-through decoration-1">{outdated.oldSource}</dd>
							</div>
							<div>
								<dt className="text-muted-foreground">{t("translations.queue.newSource")}</dt>
								<dd className="whitespace-pre-line">{outdated.newSource}</dd>
							</div>
							<div>
								<dt className="text-muted-foreground">{t("translations.editor.translation")}</dt>
								<dd className="whitespace-pre-line" lang={language}>
									{outdated.translation}
								</dd>
							</div>
						</dl>
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() => void act("confirm", outdated.at, outdated.block)}
							>
								<CheckIcon aria-hidden="true" />
								{t("translations.queue.confirm")}
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() => void act("retranslate", outdated.at, outdated.block)}
							>
								<RefreshCwIcon aria-hidden="true" />
								{t("translations.queue.retranslate")}
							</Button>
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}
