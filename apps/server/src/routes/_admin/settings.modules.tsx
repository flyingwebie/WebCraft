import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { ApiClient } from "@webcraft/api";
import { Badge } from "@webcraft/ui/components/badge.tsx";
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
import { FieldError } from "@webcraft/ui/components/field.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@webcraft/ui/components/sheet.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorMessage } from "../../ui/errors.ts";
import { formatUtc } from "../../ui/format.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { useSensitiveAction } from "../../ui/identity-check.tsx";
import { ConsentDetails, type ModuleView } from "../../ui/modules/ConsentDetails.tsx";
import { Forbidden, PageHeader } from "../../ui/PageHeader.tsx";

export const Route = createFileRoute("/_admin/settings/modules")({
	staticData: { crumb: "modules.pageTitle" },
	loader: async ({ context }) => {
		if (!context.shell.permissions.includes("module.approve")) return null;
		const api = await getApi();
		return api.modules.list();
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "modules.pageTitle") }] }),
	component: ModulesPage,
});

const LEVEL_KEYS = {
	site: "modules.level.site",
	workspace: "modules.level.workspace",
} as const satisfies Record<ModuleView["level"], MessageKey>;

const STATUS_KEYS = {
	approved: "modules.status.approved",
	waiting: "modules.status.waiting",
	"update-waiting": "modules.status.update-waiting",
	"cannot-run": "modules.status.cannot-run",
} as const satisfies Record<ModuleView["status"], MessageKey>;

/**
 * Install settings › Modules: every Module of this version of WebCraft, the version running and the
 * one approved, where each is switched, and its Module log. The Superadmin approves what a Module
 * asks for on the consent screen (a Sensitive action) and can withdraw the approval.
 */
function ModulesPage() {
	const t = useT();
	const data = Route.useLoaderData();
	if (!data) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	const { modules } = data;
	return (
		<>
			<PageHeader heading={t("modules.heading")}>{t("modules.intro")}</PageHeader>
			{modules.length === 0 ? (
				<p className="text-muted-foreground rounded-lg border border-dashed p-8 text-center">{t("modules.empty")}</p>
			) : (
				<div className="rounded-lg border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="ps-4">{t("modules.columns.module")}</TableHead>
								<TableHead>{t("modules.columns.version")}</TableHead>
								<TableHead>{t("modules.columns.status")}</TableHead>
								<TableHead className="pe-4 text-end">{t("modules.columns.actions")}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{modules.map((module) => (
								<TableRow key={module.id}>
									<TableCell className="ps-4 whitespace-normal">
										<span className="block font-medium">{module.name}</span>
										<span className="text-muted-foreground block text-xs">{module.description}</span>
										<span className="text-muted-foreground block text-xs">{t(LEVEL_KEYS[module.level])}</span>
									</TableCell>
									<TableCell className="font-mono text-xs">
										{module.version}
										{module.approval && module.approval.version !== module.version ? (
											<span className="text-muted-foreground block font-sans">
												{t("modules.approvedVersion", { version: module.approval.version })}
											</span>
										) : null}
									</TableCell>
									<TableCell className="whitespace-normal">
										<Badge variant={module.status === "approved" ? "secondary" : "outline"}>
											{t(STATUS_KEYS[module.status])}
										</Badge>
										{module.problem ? (
											<span className="text-destructive mt-1 block text-xs">
												{t("modules.cannotRun", { problem: module.problem })}
											</span>
										) : null}
									</TableCell>
									<TableCell className="pe-4 text-end">
										<div className="flex flex-wrap justify-end gap-2">
											{module.status === "waiting" || module.status === "update-waiting" ? (
												<ConsentDialog module={module} />
											) : null}
											{module.status === "approved" ? <WithdrawDialog module={module} /> : null}
											<ModuleLogSheet module={module} />
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</>
	);
}

/** The consent screen: what the Module asks for and adds, in plain words, and Approve. */
function ConsentDialog({ module }: { module: ModuleView }) {
	const t = useT();
	const router = useRouter();
	const runSensitive = useSensitiveAction();
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<MessageKey | null>(null);
	const [busy, setBusy] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const update = module.status === "update-waiting" && module.approval;

	const approve = async () => {
		setBusy(true);
		setError(null);
		try {
			const api = await getApi();
			// A Sensitive action: approving grants the Module what it asks for.
			await runSensitive(() => api.modules.approve({ moduleId: module.id, version: module.version }));
			toast.success(t("modules.consent.approved", { name: module.name, version: module.version }));
			setOpen(false);
			await router.invalidate();
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<Button
				ref={trigger}
				size="sm"
				aria-label={t("modules.reviewOf", { name: module.name })}
				onClick={() => {
					setError(null);
					setOpen(true);
				}}
			>
				{t("modules.review")}
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent closeLabel={t("modules.consent.close")} finalFocus={trigger} className="sm:max-w-lg">
					<DialogHeader className="pe-8">
						<DialogTitle>
							{update
								? t("modules.consent.updateTitle", { name: module.name, version: module.version })
								: t("modules.consent.title", { name: module.name, version: module.version })}
						</DialogTitle>
						<DialogDescription>
							{update ? t("modules.consent.updateIntro", { version: update.version }) : t("modules.consent.intro")}
						</DialogDescription>
					</DialogHeader>
					<div className="grid max-h-[60vh] gap-4 overflow-y-auto">
						<p>{module.description}</p>
						<ConsentDetails module={module} />
					</div>
					{error ? <FieldError>{t(error)}</FieldError> : null}
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("modules.consent.cancel")}</DialogClose>
						<Button onClick={approve} disabled={busy}>
							{t("modules.consent.approve")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

/** Withdraws an approval: the Module stops everywhere, keeping its data. */
function WithdrawDialog({ module }: { module: ModuleView }) {
	const t = useT();
	const router = useRouter();
	const [busy, setBusy] = useState(false);

	const withdraw = async () => {
		setBusy(true);
		try {
			const api = await getApi();
			await api.modules.withdraw({ moduleId: module.id });
			toast.success(t("modules.withdrawn", { name: module.name }));
			await router.invalidate();
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Button
			variant="outline"
			size="sm"
			onClick={withdraw}
			disabled={busy}
			aria-label={t("modules.withdrawOf", { name: module.name })}
		>
			{t("modules.withdraw")}
		</Button>
	);
}

type LogLine = Awaited<ReturnType<ApiClient["modules"]["log"]>>["lines"][number];

const LOG_LEVEL_KEYS = {
	info: "modules.log.levels.info",
	warn: "modules.log.levels.warn",
	error: "modules.log.levels.error",
} as const satisfies Record<LogLine["level"], MessageKey>;

/** The Module log, newest first, in a side panel. */
function ModuleLogSheet({ module }: { module: ModuleView }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [lines, setLines] = useState<LogLine[] | null>(null);

	const show = async () => {
		setOpen(true);
		setLines(null);
		try {
			const api = await getApi();
			setLines((await api.modules.log({ moduleId: module.id })).lines);
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
			setLines([]);
		}
	};

	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<Button variant="outline" size="sm" onClick={show} aria-label={t("modules.showLogOf", { name: module.name })}>
				{t("modules.showLog")}
			</Button>
			<SheetContent closeLabel={t("modules.log.close")} className="w-full sm:max-w-lg">
				<SheetHeader className="pe-12">
					<SheetTitle>{t("modules.log.title", { name: module.name })}</SheetTitle>
					<SheetDescription>{t("modules.log.description")}</SheetDescription>
				</SheetHeader>
				<div className="min-h-0 flex-1 overflow-y-auto p-4">
					{lines === null ? null : lines.length === 0 ? (
						<p className="text-muted-foreground">{t("modules.log.empty")}</p>
					) : (
						<ol className="grid gap-3">
							{lines.map((line) => (
								<li key={line.id} className="grid gap-1 rounded-md border p-3 text-sm">
									<div className="flex flex-wrap items-center gap-2">
										<Badge variant={line.level === "error" ? "destructive" : "outline"}>
											{t(LOG_LEVEL_KEYS[line.level])}
										</Badge>
										<time dateTime={new Date(line.at).toISOString()} className="text-muted-foreground text-xs">
											{formatUtc(line.at)}
										</time>
									</div>
									<p>{line.message}</p>
									{Object.keys(line.details).length > 0 ? (
										<pre className="bg-muted overflow-x-auto rounded p-2 text-xs">
											{JSON.stringify(line.details, null, 2)}
										</pre>
									) : null}
								</li>
							))}
						</ol>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
