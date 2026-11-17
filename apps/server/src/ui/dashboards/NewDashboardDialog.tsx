import { useNavigate } from "@tanstack/react-router";
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
import { Field, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import { XIcon } from "lucide-react";
import { type FormEvent, type ReactNode, type RefObject, useEffect, useId, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { type DashboardPlace, dashboardsApi, type TemplateView } from "./model.ts";

/** The grid's columns, as Dashboards lay Widgets out. */
const COLUMNS = 12;

/**
 * A small picture of a layout: each Widget a block where it sits on the grid, the grid's 12 columns
 * across the picture and its rows scaled to its height. Blank is an empty frame.
 */
function LayoutPicture({ layout }: { layout: readonly { x: number; y: number; w: number; h: number }[] }) {
	const rows = Math.max(1, ...layout.map((each) => each.y + each.h));
	const share = (part: number, of: number) => `${(part / of) * 100}%`;
	return (
		<span aria-hidden="true" className="bg-muted relative block h-10 w-19 overflow-hidden rounded-[4px]">
			{layout.map((each, index) => (
				<span
					// oxlint-disable-next-line react/no-array-index-key -- blocks of a picture, in a fixed order.
					key={index}
					className="absolute rounded-[2px]"
					style={{
						left: `calc(${share(each.x, COLUMNS)} + 1px)`,
						top: `calc(${share(each.y, rows)} + 1px)`,
						width: `calc(${share(each.w, COLUMNS)} - 2px)`,
						height: `calc(${share(each.h, rows)} - 2px)`,
						background: "color-mix(in oklab, var(--series-1) 45%, transparent)",
					}}
				/>
			))}
		</span>
	);
}

/** One choice of a group of radio buttons drawn as a card, the native radio kept for keyboard and screen readers. */
function ChoiceCard({
	name,
	value,
	checked,
	onChange,
	children,
	className,
}: {
	name: string;
	value: string;
	checked: boolean;
	onChange: (value: string) => void;
	children: ReactNode;
	className?: string;
}) {
	return (
		<label
			className={cn(
				"has-focus-visible:ring-ring/50 relative flex cursor-pointer rounded-lg border transition-colors has-focus-visible:ring-3",
				checked ? "border-primary ring-primary ring-1" : "hover:bg-accent",
				className,
			)}
		>
			<input
				type="radio"
				name={name}
				value={value}
				checked={checked}
				onChange={() => onChange(value)}
				className="sr-only"
			/>
			{children}
		</label>
	);
}

/**
 * New Dashboard (SPEC 14.4), a dialog over the current Dashboard: its name, what it starts from
 * (blank, or a Dashboard template, each a small picture of its layout) and who it is shown to.
 */
export function NewDashboardDialog({
	place,
	onClose,
	finalFocus,
}: {
	place: DashboardPlace;
	onClose: () => void;
	finalFocus?: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const navigate = useNavigate();
	const id = useId();
	const [name, setName] = useState("");
	const [from, setFrom] = useState("blank");
	const [everyone, setEveryone] = useState(false);
	const [missing, setMissing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [templates, setTemplates] = useState<TemplateView[]>([]);
	useEffect(() => {
		let live = true;
		void getApi()
			.then((api) => api.dashboardTemplates.list())
			.then((answer) => live && setTemplates(answer.templates))
			.catch(() => live && setTemplates([]));
		return () => {
			live = false;
		};
	}, []);

	const removeTemplate = async (template: TemplateView) => {
		try {
			await (await getApi()).dashboardTemplates.delete({ workspaceId: template.workspaceId, templateId: template.id });
			setTemplates((before) => before.filter((each) => each.id !== template.id));
			if (from === template.id) setFrom("blank");
			toast.success(t("dashboards.templateDeletedToast"));
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
		}
	};

	const create = async (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) {
			setMissing(true);
			return;
		}
		setBusy(true);
		try {
			const api = await dashboardsApi();
			const template = templates.find((each) => each.id === from);
			const made = await api.create({
				...place,
				name: name.trim(),
				template: template ? { workspaceId: template.workspaceId, templateId: template.id } : undefined,
			});
			if (everyone) await api.update({ ...place, dashboardId: made.dashboard.id, sharedWithEveryone: true });
			toast.success(t("dashboards.createdToast"));
			if (made.unmatched.length > 0)
				toast.warning(t("dashboards.unmatchedToast", { names: made.unmatched.join(", ") }));
			onClose();
			if ("workspaceId" in place) {
				await navigate({
					to: "/workspaces/$workspaceId/dashboards/$dashboardId",
					params: { workspaceId: place.workspaceId, dashboardId: made.dashboard.id },
				});
			} else {
				await navigate({
					to: "/sites/$siteId/dashboards/$dashboardId",
					params: { siteId: place.siteId, dashboardId: made.dashboard.id },
				});
			}
		} catch (failure) {
			toast.error(t(errorMessage(failure)));
			setBusy(false);
		}
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				closeLabel={t("dashboards.close")}
				finalFocus={finalFocus}
				showCloseButton={false}
				className="sm:max-w-[30rem]"
			>
				<form onSubmit={create} noValidate>
					<DialogHeader>
						<DialogTitle className="text-lg">{t("dashboards.newTitle")}</DialogTitle>
						<DialogDescription className="sr-only">{t("dashboards.newIntro")}</DialogDescription>
					</DialogHeader>
					<FieldGroup className="mt-5 mb-6 gap-5">
						<Field data-invalid={missing ? true : undefined} className="gap-2">
							<FieldLabel htmlFor={`${id}-name`}>{t("dashboards.name")}</FieldLabel>
							<Input
								id={`${id}-name`}
								value={name}
								required
								maxLength={100}
								autoFocus
								placeholder={t("dashboards.namePlaceholder")}
								onChange={(change) => {
									setName(change.target.value);
									setMissing(false);
								}}
								aria-invalid={missing ? true : undefined}
								aria-describedby={missing ? `${id}-name-error` : undefined}
							/>
							{missing ? <FieldError id={`${id}-name-error`}>{t("dashboards.nameRequired")}</FieldError> : null}
						</Field>
						<fieldset className="grid gap-2">
							<legend className="mb-2 text-sm font-medium">{t("dashboards.startFrom")}</legend>
							<div className="flex flex-wrap gap-2">
								<ChoiceCard name={`${id}-from`} value="blank" checked={from === "blank"} onChange={setFrom}>
									<span className="flex w-24 flex-col items-center gap-2 p-2">
										<LayoutPicture layout={[]} />
										<span className="text-xs font-medium">{t("dashboards.blankShort")}</span>
									</span>
								</ChoiceCard>
								{templates.map((template) => (
									<div key={template.id} className="group/template relative">
										<ChoiceCard
											name={`${id}-from`}
											value={template.id}
											checked={from === template.id}
											onChange={setFrom}
										>
											<span className="flex w-24 flex-col items-center gap-2 p-2">
												<LayoutPicture layout={template.layout} />
												<span className="w-full truncate text-center text-xs font-medium" title={template.name}>
													{template.name}
												</span>
												<span className="sr-only">
													{t("dashboards.templateOption", {
														name: "",
														workspace: template.workspace,
														widgets: template.widgets,
													})}
												</span>
											</span>
										</ChoiceCard>
										<Button
											type="button"
											variant="outline"
											size="icon-xs"
											className="bg-background absolute -end-2 -top-2 opacity-0 group-focus-within/template:opacity-100 group-hover/template:opacity-100 focus-visible:opacity-100"
											aria-label={t("dashboards.deleteTemplateFor", { name: template.name })}
											title={t("dashboards.deleteTemplateFor", { name: template.name })}
											onClick={() => removeTemplate(template)}
										>
											<XIcon aria-hidden="true" />
										</Button>
									</div>
								))}
							</div>
						</fieldset>
						<fieldset className="grid gap-2">
							<legend className="mb-2 text-sm font-medium">{t("dashboards.shownTo")}</legend>
							<div className="bg-muted inline-flex w-fit gap-1 rounded-lg p-1">
								{[false, true].map((value) => (
									<label
										key={String(value)}
										className={cn(
											"has-focus-visible:ring-ring/50 cursor-pointer rounded-md px-3 py-1.5 text-sm transition-colors has-focus-visible:ring-3",
											everyone === value
												? "bg-background text-foreground font-medium shadow-xs"
												: "text-muted-foreground hover:text-foreground",
										)}
									>
										<input
											type="radio"
											name={`${id}-shown`}
											checked={everyone === value}
											onChange={() => setEveryone(value)}
											className="sr-only"
										/>
										{t(value ? "dashboards.shownEveryone" : "dashboards.shownViewers")}
									</label>
								))}
							</div>
						</fieldset>
					</FieldGroup>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>{t("dashboards.cancel")}</DialogClose>
						<Button type="submit" disabled={busy}>
							{t("dashboards.create")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
