import { createFileRoute, Link, Outlet, useNavigate, useRouter } from "@tanstack/react-router";
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { Label } from "@webcraft/ui/components/label.tsx";
import { PlusIcon, RepeatIcon } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { getApi } from "../../ui/api.ts";
import { StatusBadge } from "../../ui/content/DraftParts.tsx";
import { errorCode, errorMessage } from "../../ui/errors.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";

/**
 * Site › Loops (Structure, Staff only): the Site's Loops beside the screen of the one that is open.
 * Members never see it: the sidebar hides the Structure group, and the page says they can't open it.
 */
export const Route = createFileRoute("/_admin/sites/$siteId/loops")({
	staticData: { crumb: "loops.pageTitle", wide: true },
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("structure.edit")) return { loops: null };
		const api = await getApi();
		const { loops } = await api.loops.list({ siteId: params.siteId });
		return { loops };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "loops.pageTitle") }] }),
	component: LoopsLayout,
});

function LoopsLayout() {
	const t = useT();
	const { loops } = Route.useLoaderData();
	const { siteId } = Route.useParams();
	if (!loops) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	const linkClass =
		"hover:bg-muted focus-visible:ring-ring/50 aria-[current=page]:bg-muted flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-3 aria-[current=page]:font-medium";
	return (
		<div className="grid gap-8 lg:grid-cols-[14rem_minmax(0,1fr)]">
			<nav aria-labelledby="loops-nav-heading" className="grid content-start gap-2">
				<div className="flex items-center justify-between gap-2 px-2">
					<h2 id="loops-nav-heading" className="font-semibold">
						{t("loops.listHeading")}
					</h2>
					<NewLoopDialog siteId={siteId} />
				</div>
				{loops.length === 0 ? (
					<p className="text-muted-foreground px-2 text-sm">{t("loops.none")}</p>
				) : (
					<ul className="grid gap-1">
						{loops.map((loop) => (
							<li key={loop.id}>
								<Link to="/sites/$siteId/loops/$loopId" params={{ siteId, loopId: loop.id }} className={linkClass}>
									<RepeatIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
									<span className="truncate font-mono">{loop.name}</span>
									<span className="ms-auto">
										<StatusBadge status={loop.status} />
									</span>
								</Link>
							</li>
						))}
					</ul>
				)}
			</nav>
			<Outlet />
		</div>
	);
}

/** Creates a Loop from its name (how Template markup names it) and where its items come from. */
function NewLoopDialog({ siteId }: { siteId: string }) {
	const t = useT();
	const navigate = useNavigate();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [source, setSource] = useState<"query" | "items">("query");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!name.trim()) {
			setError(t("loops.create.nameRequired"));
			return;
		}
		setBusy(true);
		try {
			const api = await getApi();
			const { loop } = await api.loops.create({ siteId, name: name.trim(), source });
			toast.success(t("loops.create.created", { name: loop.name }));
			setOpen(false);
			setName("");
			setError(null);
			await router.invalidate();
			await navigate({ to: "/sites/$siteId/loops/$loopId", params: { siteId, loopId: loop.id } });
		} catch (failure) {
			const data = (failure as { data?: { problems?: { at: string; message: string }[] } }).data;
			setError(
				errorCode(failure) === "LOOP_INVALID" && data?.problems
					? data.problems.map((problem) => problem.message).join(" ")
					: t(errorMessage(failure)),
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<Button
				ref={trigger}
				type="button"
				variant="ghost"
				size="icon-sm"
				aria-label={t("loops.create.open")}
				onClick={() => setOpen(true)}
			>
				<PlusIcon aria-hidden="true" />
			</Button>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) setError(null);
				}}
			>
				<DialogContent closeLabel={t("loops.create.close")} finalFocus={trigger}>
					<form onSubmit={submit} className="grid gap-6" noValidate>
						<DialogHeader>
							<DialogTitle>{t("loops.create.title")}</DialogTitle>
							<DialogDescription>{t("loops.create.intro")}</DialogDescription>
						</DialogHeader>
						<FieldGroup className="gap-4">
							<Field data-invalid={error ? true : undefined}>
								<FieldLabel htmlFor="new-loop-name">{t("loops.create.name")}</FieldLabel>
								<Input
									id="new-loop-name"
									value={name}
									onChange={(event) => setName(event.target.value)}
									autoComplete="off"
									spellCheck={false}
									className="font-mono"
									aria-invalid={error ? true : undefined}
									aria-describedby={["new-loop-name-help", error ? "new-loop-name-error" : null]
										.filter(Boolean)
										.join(" ")}
								/>
								<FieldDescription id="new-loop-name-help">{t("loops.create.nameHelp")}</FieldDescription>
								{error ? <FieldError id="new-loop-name-error">{error}</FieldError> : null}
							</Field>
							<fieldset className="grid gap-2">
								<legend className="mb-1 text-sm font-medium">{t("loops.source.heading")}</legend>
								{(["query", "items"] as const).map((option) => (
									<div key={option} className="flex items-center gap-2">
										<input
											type="radio"
											id={`new-loop-source-${option}`}
											name="new-loop-source"
											value={option}
											checked={source === option}
											onChange={() => setSource(option)}
											className="accent-primary size-4"
										/>
										<Label htmlFor={`new-loop-source-${option}`}>{t(`loops.source.${option}`)}</Label>
									</div>
								))}
							</fieldset>
						</FieldGroup>
						<DialogFooter>
							<DialogClose render={<Button variant="outline" type="button" />}>{t("loops.create.cancel")}</DialogClose>
							<Button type="submit" disabled={busy}>
								{t("loops.create.submit")}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
