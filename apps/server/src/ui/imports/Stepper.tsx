import { Link } from "@tanstack/react-router";
import { cn } from "@webcraft/ui/lib/utils.ts";
import { ArrowLeftIcon, CheckIcon } from "lucide-react";
import { type ReactNode, type Ref, useId } from "react";

import { useT } from "../i18n.tsx";
import { PageAside } from "../shell/page.tsx";
import { SecondaryTitle, secondaryRowClass } from "../shell/SecondarySidebar.tsx";

/** The five steps of an Import, in order. */
export const IMPORT_STEPS = ["source", "map", "preview", "run", "report"] as const;

export type ImportStep = (typeof IMPORT_STEPS)[number];

/**
 * The top of every step of an Import, in the page frame: the five steps listed down the left in the
 * secondary sidebar's place, as the setup lists its own (done ones ticked, the current one filled),
 * with the way back to the Imports under them; then the page header: the step's heading (focused as
 * a step opens, so it is announced), one line about it, and its actions, the main one last. On a
 * phone, where the steps have no room beside the page, the line says which step of five this is.
 */
export function ImportHeader({
	siteId,
	current,
	heading,
	headingRef,
	line,
	actions,
}: {
	siteId: string;
	current: ImportStep;
	heading: string;
	headingRef: Ref<HTMLHeadingElement>;
	line: ReactNode;
	actions: ReactNode;
}) {
	const t = useT();
	const at = IMPORT_STEPS.indexOf(current);
	return (
		<>
			<ImportSteps siteId={siteId} current={current} />
			<header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
				<div className="min-w-0 space-y-1">
					<h1 ref={headingRef} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
						{heading}
					</h1>
					<p className="text-muted-foreground text-base">
						<span className="md:hidden">
							{t("imports.steps.position", { number: at + 1, step: t(`imports.steps.${current}`) })}
							{" · "}
						</span>
						{line}
					</p>
				</div>
				<div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
			</header>
		</>
	);
}

/** The steps, in the secondary sidebar's place. */
function ImportSteps({ siteId, current }: { siteId: string; current: ImportStep }) {
	const t = useT();
	const id = useId();
	const at = IMPORT_STEPS.indexOf(current);
	return (
		<PageAside>
			<aside
				aria-labelledby={`${id}-title`}
				data-slot="secondary-sidebar"
				className="bg-background hidden w-56 shrink-0 flex-col gap-1 overflow-y-auto border-e p-3 md:flex"
			>
				<SecondaryTitle id={`${id}-title`}>{t("imports.steps.label")}</SecondaryTitle>
				<ol aria-labelledby={`${id}-title`} className="flex flex-col gap-1 px-2 pt-1">
					{IMPORT_STEPS.map((step, index) => {
						const done = index < at;
						const isCurrent = index === at;
						return (
							<li
								key={step}
								aria-current={isCurrent ? "step" : undefined}
								className="flex h-8 items-center gap-2.5 text-sm"
							>
								<span
									aria-hidden="true"
									className={cn(
										"flex size-[22px] shrink-0 items-center justify-center rounded-full text-xs font-semibold",
										done
											? "bg-green-700 text-white dark:bg-green-600"
											: isCurrent
												? "bg-primary text-primary-foreground"
												: "text-muted-foreground border",
									)}
								>
									{done ? <CheckIcon className="size-[13px]" strokeWidth={3} /> : index + 1}
								</span>
								<span className={isCurrent ? "font-semibold" : done ? undefined : "text-muted-foreground"}>
									{t(`imports.steps.${step}`)}
									{done ? <span className="sr-only"> {t("imports.steps.done")}</span> : null}
								</span>
							</li>
						);
					})}
				</ol>
				<div className="mt-auto border-t pt-2">
					<Link
						to="/sites/$siteId/imports"
						params={{ siteId }}
						// Not marked as the page: this is the way back, not where the person is.
						activeOptions={{ exact: true }}
						className={secondaryRowClass}
					>
						<ArrowLeftIcon className="rtl:rotate-180" aria-hidden="true" />
						{t("imports.flow.backToList")}
					</Link>
				</div>
			</aside>
		</PageAside>
	);
}
