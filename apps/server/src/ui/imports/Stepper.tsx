import { cn } from "@webcraft/ui/lib/utils.ts";
import { CheckIcon } from "lucide-react";

import { useT } from "../i18n.tsx";

/** The five steps of an Import, in order. */
export const IMPORT_STEPS = ["source", "map", "preview", "run", "report"] as const;

export type ImportStep = (typeof IMPORT_STEPS)[number];

/** Where an Import is among its steps: the ones before the current step are done. */
export function Stepper({ current }: { current: ImportStep }) {
	const t = useT();
	const at = IMPORT_STEPS.indexOf(current);
	return (
		<nav aria-label={t("imports.steps.label")}>
			<ol className="flex flex-wrap items-center gap-2 text-sm">
				{IMPORT_STEPS.map((step, index) => {
					const done = index < at;
					const isCurrent = index === at;
					const name = t(`imports.steps.${step}`);
					return (
						<li key={step} className="flex items-center gap-2" aria-current={isCurrent ? "step" : undefined}>
							{index > 0 ? (
								<span aria-hidden="true" className={cn("h-px w-6", done || isCurrent ? "bg-primary" : "bg-border")} />
							) : null}
							<span
								aria-hidden="true"
								className={cn(
									"flex size-6 items-center justify-center rounded-full border text-xs",
									done && "bg-primary border-primary text-primary-foreground",
									isCurrent && "border-primary text-primary border-2",
								)}
							>
								{done ? <CheckIcon className="size-3.5" /> : index + 1}
							</span>
							<span className={cn(isCurrent ? "font-medium" : "text-muted-foreground")}>
								{name}
								{done ? <span className="sr-only"> {t("imports.steps.done")}</span> : null}
							</span>
						</li>
					);
				})}
			</ol>
		</nav>
	);
}
