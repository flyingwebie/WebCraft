import { useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Checkbox } from "@webcraft/ui/components/checkbox.tsx";
import { Skeleton } from "@webcraft/ui/components/skeleton.tsx";
import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { useSensitiveAction } from "../identity-check.tsx";
import { ConsentDetails, type ModuleView } from "../modules/ConsentDetails.tsx";
import { StepHeader } from "./StepHeader.tsx";
import type { StepPanelProps } from "./steps.tsx";

/**
 * The Modules step: the first-party Modules of this version of WebCraft that wait for approval,
 * ticked, each with what it asks for in plain words. The Superadmin approves the ticked ones
 * (each a Sensitive action; they signed in moments ago) and can approve the rest later.
 */
export function ModulesStep({ isLast, onDone, onBack }: StepPanelProps) {
	const t = useT();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const id = useId();
	const [waiting, setWaiting] = useState<ModuleView[] | null>(null);
	const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let current = true;
		(async () => {
			const api = await getApi();
			const { modules } = await api.modules.list();
			const open = modules.filter((module) => module.status === "waiting" || module.status === "update-waiting");
			if (!current) return;
			setWaiting(open);
			// First-party Modules come ticked.
			setTicked(new Set(open.map((module) => module.id)));
		})().catch((error: unknown) => toast.error(t(errorMessage(error))));
		return () => {
			current = false;
		};
	}, [t]);

	const next = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			for (const module of waiting ?? []) {
				if (!ticked.has(module.id)) continue;
				await runSensitive(() => api.modules.approve({ moduleId: module.id, version: module.version }));
			}
			if (!isLast) {
				onDone();
				return;
			}
			await api.setup.finish();
			await router.navigate({ to: "/" });
		} catch (error) {
			toast.error(t(errorMessage(error)));
			setBusy(false);
		}
	};

	const toggle = (moduleId: string, checked: boolean) =>
		setTicked((before) => {
			const after = new Set(before);
			if (checked) after.add(moduleId);
			else after.delete(moduleId);
			return after;
		});

	const anyTicked = (waiting ?? []).some((module) => ticked.has(module.id));

	return (
		<div className="flex flex-1 flex-col gap-8">
			<StepHeader heading={t("setup.steps.modules.heading")}>
				<p>{t("setup.steps.modules.intro")}</p>
				<p>{t("setup.steps.modules.later")}</p>
			</StepHeader>
			{waiting === null ? (
				<div className="grid gap-3">
					<Skeleton className="h-16 w-full" />
					<Skeleton className="h-16 w-full" />
				</div>
			) : waiting.length === 0 ? (
				<p className="text-muted-foreground">{t("setup.steps.modules.none")}</p>
			) : (
				<ul className="grid gap-4">
					{waiting.map((module) => (
						<li key={module.id} className="grid gap-3 rounded-lg border p-4">
							<div className="flex items-start gap-3">
								<Checkbox
									id={`${id}-${module.id}`}
									checked={ticked.has(module.id)}
									onCheckedChange={(checked) => toggle(module.id, checked === true)}
									aria-describedby={`${id}-${module.id}-description`}
									className="mt-0.5"
								/>
								<span className="grid gap-1">
									<label htmlFor={`${id}-${module.id}`} className="font-medium">
										{module.name} <span className="text-muted-foreground font-mono text-xs">{module.version}</span>
									</label>
									<span id={`${id}-${module.id}-description`} className="text-muted-foreground text-sm">
										{module.description}
									</span>
								</span>
							</div>
							<details className="ps-7 text-sm">
								<summary className="cursor-pointer font-medium">
									{t("setup.steps.modules.details", { name: module.name })}
								</summary>
								<div className="pt-3">
									<ConsentDetails module={module} headingLevel={2} />
								</div>
							</details>
						</li>
					))}
				</ul>
			)}
			<div className="mt-auto flex flex-wrap items-center justify-end gap-2">
				{onBack ? (
					<Button type="button" variant="ghost" className="me-auto" onClick={onBack}>
						<ArrowLeftIcon className="rtl:rotate-180" aria-hidden="true" />
						{t("setup.back")}
					</Button>
				) : null}
				<Button onClick={next} disabled={busy || waiting === null}>
					{anyTicked
						? isLast
							? t("setup.steps.modules.approveAndFinish")
							: t("setup.steps.modules.approveAndContinue")
						: isLast
							? t("setup.steps.modules.finish")
							: t("setup.steps.modules.continue")}
				</Button>
			</div>
		</div>
	);
}
