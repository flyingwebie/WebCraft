import { useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@webcraft/ui/components/dropdown-menu.tsx";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@webcraft/ui/components/table.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { cn } from "@webcraft/ui/lib/utils.ts";
import { ArrowDownIcon, ArrowUpIcon, EllipsisIcon, PencilIcon, PlusIcon, TrashIcon } from "lucide-react";
import { type FormEvent, type RefObject, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { cellClass, headClass, headRowClass, TableFrame } from "../analytics/parts.tsx";
import { getApi } from "../api.ts";
import { Announcer, moveItem, useAnnouncement } from "../content/reorder.tsx";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { PageHeader } from "../PageHeader.tsx";
import { ConfirmDialog } from "../settings/confirm.tsx";
import { PageSheet } from "../shell/page.tsx";

type Service = { id: string; name: string; description: string };

/** As many services as the list may hold. */
const MOST = 30;

/**
 * The Services list (GLOSSARY.md): the services the agency offers, written by Staff once for the whole
 * Install. Reports' AI suggestions may point to one of them. Drawn as a list with a sheet, as Site ›
 * Goals: a row per service with its menu (Edit, Move up, Move down, Remove); adding and changing one
 * is a sheet over the page. Every change is saved at once, the whole list in its order, and every
 * move is said in a live region.
 */
export function ServicesListPage({ services: saved }: { services: readonly Service[] }) {
	const t = useT();
	const router = useRouter();
	const [services, setServices] = useState<readonly Service[]>(saved);
	const [announcement, announce] = useAnnouncement();
	const addButton = useRef<HTMLButtonElement>(null);
	const [editing, setEditing] = useState<{ index: number | null; from: RefObject<HTMLElement | null> } | null>(null);
	const [removing, setRemoving] = useState<{ index: number; from: RefObject<HTMLElement | null> } | null>(null);

	/** Saves the whole list; answers whether it was saved. The rows show the new order at once. */
	const persist = async (next: readonly { id?: string; name: string; description: string }[]): Promise<boolean> => {
		const before = services;
		if (next.every((service): service is Service => Boolean(service.id))) setServices(next);
		try {
			const answer = await (await getApi()).servicesList.update({ services: next.map((service) => ({ ...service })) });
			setServices(answer.services);
			await router.invalidate();
			return true;
		} catch (failure) {
			setServices(before);
			toast.error(t(errorMessage(failure)));
			return false;
		}
	};
	const move = async (index: number, by: -1 | 1) => {
		const moved = services[index];
		if (!moved) return;
		if (await persist(moveItem(services, index, index + by))) {
			announce(t("servicesList.moved", { name: moved.name || t("servicesList.unnamed"), position: index + by + 1 }));
		}
	};

	return (
		<>
			<PageHeader
				heading={t("servicesList.heading")}
				action={
					<Button
						ref={addButton}
						disabled={services.length >= MOST}
						onClick={() => setEditing({ index: null, from: addButton })}
					>
						<PlusIcon aria-hidden="true" />
						{t("servicesList.add")}
					</Button>
				}
			>
				{t("servicesList.intro")}
			</PageHeader>
			<TableFrame>
				<Table aria-label={t("servicesList.heading")} className="min-w-140 table-fixed">
					<colgroup>
						<col className="w-12" />
						<col className="w-[30%]" />
						<col />
						<col className="w-14" />
					</colgroup>
					<TableHeader>
						<TableRow className={headRowClass}>
							<TableHead scope="col" className={headClass}>
								<span className="sr-only">{t("servicesList.position")}</span>
							</TableHead>
							<TableHead scope="col" className={headClass}>
								{t("servicesList.nameColumn")}
							</TableHead>
							<TableHead scope="col" className={headClass}>
								{t("servicesList.descriptionColumn")}
							</TableHead>
							<TableHead scope="col" className={headClass}>
								<span className="sr-only">{t("servicesList.actions")}</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{services.length === 0 ? (
							<TableRow className="hover:bg-transparent">
								<TableCell colSpan={4} className="text-muted-foreground px-4 py-8 text-center whitespace-normal">
									{t("servicesList.empty")}
								</TableCell>
							</TableRow>
						) : (
							services.map((service, index) => (
								<TableRow key={service.id}>
									<TableCell className={cn(cellClass, "text-muted-foreground tabular-nums")}>{index + 1}</TableCell>
									<TableCell className={cn(cellClass, "truncate font-medium")} title={service.name}>
										{service.name}
									</TableCell>
									<TableCell
										className={cn(cellClass, "text-muted-foreground truncate")}
										title={service.description || undefined}
									>
										{service.description}
									</TableCell>
									<TableCell className={cn(cellClass, "text-end")}>
										<ServiceMenu
											name={service.name}
											first={index === 0}
											last={index === services.length - 1}
											onEdit={(from) => setEditing({ index, from })}
											onMove={(by) => void move(index, by)}
											onRemove={(from) => setRemoving({ index, from })}
										/>
									</TableCell>
								</TableRow>
							))
						)}
					</TableBody>
				</Table>
			</TableFrame>
			<Announcer message={announcement} />
			{editing ? (
				<ServiceSheet
					service={editing.index === null ? null : (services[editing.index] ?? null)}
					finalFocus={editing.from}
					onClose={() => setEditing(null)}
					onSave={async (changed) => {
						const index = editing.index;
						const next =
							index === null
								? [...services, changed]
								: services.map((service, at) => (at === index ? { ...service, ...changed } : service));
						if (!(await persist(next))) return false;
						toast.success(t("servicesList.saved"));
						return true;
					}}
				/>
			) : null}
			{removing ? (
				<ConfirmDialog
					open
					onOpenChange={(open) => !open && setRemoving(null)}
					title={t("servicesList.removeTitle", { name: services[removing.index]?.name ?? "" })}
					confirm={t("servicesList.removeConfirm")}
					// The row and its menu are gone after removing: focus goes to Add service.
					finalFocus={addButton}
					onConfirm={async () => {
						const gone = services[removing.index];
						if (!gone) return;
						if (await persist(services.filter((_, at) => at !== removing.index))) {
							announce(t("servicesList.removed", { name: gone.name || t("servicesList.unnamed") }));
						}
					}}
				>
					{t("servicesList.removeText")}
				</ConfirmDialog>
			) : null}
		</>
	);
}

/** A service's menu: Edit, Move up, Move down and Remove. */
function ServiceMenu({
	name,
	first,
	last,
	onEdit,
	onMove,
	onRemove,
}: {
	name: string;
	first: boolean;
	last: boolean;
	onEdit: (from: RefObject<HTMLElement | null>) => void;
	onMove: (by: -1 | 1) => void;
	onRemove: (from: RefObject<HTMLElement | null>) => void;
}) {
	const t = useT();
	const trigger = useRef<HTMLButtonElement>(null);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				ref={trigger}
				render={<Button variant="ghost" size="icon-sm" aria-label={t("servicesList.actionsOf", { name })} />}
			>
				<EllipsisIcon aria-hidden="true" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-auto min-w-40">
				<DropdownMenuItem onClick={() => onEdit(trigger)}>
					<PencilIcon aria-hidden="true" />
					{t("servicesList.edit")}
				</DropdownMenuItem>
				<DropdownMenuItem disabled={first} onClick={() => onMove(-1)}>
					<ArrowUpIcon aria-hidden="true" />
					{t("servicesList.moveUpItem")}
				</DropdownMenuItem>
				<DropdownMenuItem disabled={last} onClick={() => onMove(1)}>
					<ArrowDownIcon aria-hidden="true" />
					{t("servicesList.moveDownItem")}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem variant="destructive" onClick={() => onRemove(trigger)}>
					<TrashIcon aria-hidden="true" />
					{t("servicesList.removeItem")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Adding a service, or changing one: its name and what it is. */
function ServiceSheet({
	service,
	onSave,
	onClose,
	finalFocus,
}: {
	service: Service | null;
	/** Saves the list with this service; answers whether it was saved. */
	onSave: (service: { name: string; description: string }) => Promise<boolean>;
	onClose: () => void;
	finalFocus: RefObject<HTMLElement | null>;
}) {
	const t = useT();
	const id = useId();
	const [name, setName] = useState(service?.name ?? "");
	const [description, setDescription] = useState(service?.description ?? "");
	const [busy, setBusy] = useState(false);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) return;
		setBusy(true);
		const saved = await onSave({ name: name.trim(), description: description.trim() });
		setBusy(false);
		if (saved) onClose();
	};
	return (
		<PageSheet
			open
			onOpenChange={(open) => !open && onClose()}
			title={service ? t("servicesList.editTitle", { name: service.name }) : t("servicesList.add")}
			description={t("servicesList.sheetIntro")}
			finalFocus={finalFocus}
			className="data-[side=right]:sm:max-w-95"
			footer={
				<>
					<Button type="button" variant="outline" onClick={onClose}>
						{t("servicesList.cancel")}
					</Button>
					<Button type="submit" form={`${id}-form`} disabled={busy || !name.trim()}>
						{service ? t("servicesList.saveService") : t("servicesList.add")}
					</Button>
				</>
			}
		>
			<form id={`${id}-form`} onSubmit={save} noValidate>
				<FieldGroup className="gap-5">
					<Field>
						<FieldLabel htmlFor={`${id}-name`}>{t("servicesList.nameColumn")}</FieldLabel>
						<Input
							id={`${id}-name`}
							value={name}
							required
							autoFocus
							maxLength={100}
							onChange={(event) => setName(event.target.value)}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor={`${id}-description`}>{t("servicesList.descriptionColumn")}</FieldLabel>
						<Textarea
							id={`${id}-description`}
							value={description}
							rows={4}
							maxLength={500}
							onChange={(event) => setDescription(event.target.value)}
							aria-describedby={`${id}-description-help`}
						/>
						<FieldDescription id={`${id}-description-help`}>{t("servicesList.descriptionHelp")}</FieldDescription>
					</Field>
				</FieldGroup>
			</form>
		</PageSheet>
	);
}
