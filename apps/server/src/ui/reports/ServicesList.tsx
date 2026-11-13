import { useRouter } from "@tanstack/react-router";
import { Button } from "@webcraft/ui/components/button.tsx";
import { Field, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Textarea } from "@webcraft/ui/components/textarea.tsx";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../api.ts";
import { errorMessage } from "../errors.ts";
import { useT } from "../i18n.tsx";
import { PageHeader } from "../PageHeader.tsx";

type Service = { id?: string; name: string; description: string };

/**
 * The Services list (GLOSSARY.md): the services the agency offers, written by Staff once for the whole
 * Install. Reports' AI suggestions may point to one of them. Each can be moved up and down from the
 * keyboard, and every move is said in a live region.
 */
export function ServicesListPage({
	services: saved,
}: {
	services: readonly { id: string; name: string; description: string }[];
}) {
	const t = useT();
	const router = useRouter();
	const id = useId();
	const [services, setServices] = useState<Service[]>(saved.map((service) => ({ ...service })));
	const [said, setSaid] = useState("");
	const [busy, setBusy] = useState(false);
	const addButton = useRef<HTMLButtonElement>(null);
	const change = (index: number, patch: Partial<Service>) =>
		setServices((current) => current.map((service, at) => (at === index ? { ...service, ...patch } : service)));
	const move = (index: number, by: -1 | 1) => {
		setServices((current) => {
			const next = [...current];
			const [moved] = next.splice(index, 1);
			if (moved) next.splice(index + by, 0, moved);
			setSaid(t("servicesList.moved", { name: moved?.name || t("servicesList.unnamed"), position: index + by + 1 }));
			return next;
		});
	};
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			const answer = await (await getApi()).servicesList.update({ services });
			setServices(answer.services.map((service) => ({ ...service })));
			toast.success(t("servicesList.saved"));
			await router.invalidate();
		} catch (error) {
			toast.error(t(errorMessage(error)));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="max-w-3xl">
			<PageHeader heading={t("servicesList.heading")}>{t("servicesList.intro")}</PageHeader>
			<form onSubmit={save} noValidate className="space-y-6">
				{services.length === 0 ? <p className="text-muted-foreground">{t("servicesList.empty")}</p> : null}
				<ol className="space-y-4">
					{services.map((service, index) => (
						<li key={service.id ?? `new-${index}`} className="space-y-3 rounded-md border p-4">
							<FieldGroup className="gap-4">
								<Field>
									<FieldLabel htmlFor={`${id}-name-${index}`}>{t("servicesList.name", { n: index + 1 })}</FieldLabel>
									<Input
										id={`${id}-name-${index}`}
										value={service.name}
										required
										maxLength={100}
										onChange={(event) => change(index, { name: event.target.value })}
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor={`${id}-description-${index}`}>
										{t("servicesList.description", { n: index + 1 })}
									</FieldLabel>
									<Textarea
										id={`${id}-description-${index}`}
										value={service.description}
										rows={2}
										maxLength={500}
										onChange={(event) => change(index, { description: event.target.value })}
									/>
								</Field>
							</FieldGroup>
							<div className="flex flex-wrap gap-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={index === 0}
									onClick={() => move(index, -1)}
								>
									<ArrowUpIcon aria-hidden="true" />
									{t("servicesList.moveUp", { n: index + 1 })}
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={index === services.length - 1}
									onClick={() => move(index, 1)}
								>
									<ArrowDownIcon aria-hidden="true" />
									{t("servicesList.moveDown", { n: index + 1 })}
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => {
										setServices((current) => current.filter((_, at) => at !== index));
										setSaid(t("servicesList.removed", { name: service.name || t("servicesList.unnamed") }));
										addButton.current?.focus();
									}}
								>
									<TrashIcon aria-hidden="true" />
									{t("servicesList.remove", { n: index + 1 })}
								</Button>
							</div>
						</li>
					))}
				</ol>
				<div className="flex flex-wrap gap-2">
					<Button
						ref={addButton}
						type="button"
						variant="outline"
						onClick={() => setServices((current) => [...current, { name: "", description: "" }])}
						disabled={services.length >= 30}
					>
						<PlusIcon aria-hidden="true" />
						{t("servicesList.add")}
					</Button>
					<Button type="submit" disabled={busy}>
						{t("servicesList.save")}
					</Button>
				</div>
				<p className="sr-only" aria-live="polite">
					{said}
				</p>
			</form>
		</div>
	);
}
