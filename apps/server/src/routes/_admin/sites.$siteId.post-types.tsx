import { createFileRoute, Link, Outlet, useNavigate, useRouter } from "@tanstack/react-router";
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@webcraft/ui/components/field.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { FileTextIcon, NewspaperIcon, PlusIcon, SlidersHorizontalIcon } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { toast } from "sonner";

import { getApi } from "../../ui/api.ts";
import { errorCode, errorMessage } from "../../ui/errors.ts";
import { type MessageKey, pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";

/**
 * Site › Post Types & Fields (Structure, Staff only): the Site's Post Types and the Globals beside the
 * editor of the one that is open. Members never see it: the sidebar hides the Structure group, and
 * the page says they can't open it.
 */
export const Route = createFileRoute("/_admin/sites/$siteId/post-types")({
	staticData: { crumb: "postTypes.pageTitle", wide: true },
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("structure.edit")) return { postTypes: null };
		const api = await getApi();
		const { postTypes } = await api.postTypes.list({ siteId: params.siteId });
		return { postTypes };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "postTypes.pageTitle") }] }),
	component: PostTypesLayout,
});

function PostTypesLayout() {
	const t = useT();
	const { postTypes } = Route.useLoaderData();
	const { siteId } = Route.useParams();
	if (!postTypes) return <Forbidden heading={t("forbidden.heading")} body={t("forbidden.body")} />;
	const ordered = [...postTypes].sort((a, b) => Number(b.builtIn === "page") - Number(a.builtIn === "page"));
	const linkClass =
		"hover:bg-muted focus-visible:ring-ring/50 aria-[current=page]:bg-muted flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none focus-visible:ring-3 aria-[current=page]:font-medium";
	return (
		<div className="grid gap-8 lg:grid-cols-[14rem_minmax(0,1fr)]">
			<nav aria-labelledby="post-types-nav-heading" className="grid content-start gap-2">
				<div className="flex items-center justify-between gap-2 px-2">
					<h2 id="post-types-nav-heading" className="font-semibold">
						{t("postTypes.listHeading")}
					</h2>
					<NewPostTypeDialog siteId={siteId} />
				</div>
				<ul className="grid gap-1">
					{ordered.map((postType) => (
						<li key={postType.id}>
							<Link
								to="/sites/$siteId/post-types/$postTypeId"
								params={{ siteId, postTypeId: postType.id }}
								className={linkClass}
							>
								{postType.builtIn === "page" ? (
									<FileTextIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
								) : (
									<NewspaperIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
								)}
								<span className="truncate">{postType.name}</span>
								{postType.builtIn === "page" ? (
									<Badge variant="outline" className="ms-auto">
										{t("postTypes.builtIn")}
									</Badge>
								) : null}
							</Link>
						</li>
					))}
				</ul>
				<ul className="grid gap-1 border-t pt-2">
					<li>
						<Link to="/sites/$siteId/post-types/globals" params={{ siteId }} className={linkClass}>
							<SlidersHorizontalIcon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
							<span className="truncate">{t("postTypes.globals.heading")}</span>
						</Link>
					</li>
				</ul>
			</nav>
			<Outlet />
		</div>
	);
}

/** Creates a Post Type from a name and URL pattern (its key is made from the name unless given). */
function NewPostTypeDialog({ siteId }: { siteId: string }) {
	const t = useT();
	const navigate = useNavigate();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [urlPattern, setUrlPattern] = useState("");
	const [key, setKey] = useState("");
	const [errors, setErrors] = useState<Partial<Record<"name" | "urlPattern" | "key" | "form", string>>>({});
	const [busy, setBusy] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const missing: typeof errors = {};
		if (!name.trim()) missing.name = t("postTypes.create.nameRequired");
		if (!urlPattern.trim()) missing.urlPattern = t("postTypes.create.urlPatternRequired");
		setErrors(missing);
		if (Object.keys(missing).length > 0) return;
		setBusy(true);
		try {
			const api = await getApi();
			const { postType } = await api.postTypes.create({
				siteId,
				name: name.trim(),
				urlPattern: urlPattern.trim(),
				key: key.trim() || undefined,
			});
			toast.success(t("postTypes.create.created", { name: postType.name }));
			setOpen(false);
			setName("");
			setUrlPattern("");
			setKey("");
			await router.invalidate();
			await navigate({ to: "/sites/$siteId/post-types/$postTypeId", params: { siteId, postTypeId: postType.id } });
		} catch (failure) {
			const code = errorCode(failure);
			const data = (failure as { data?: { problems?: { at: string; message: string }[]; field?: string } }).data;
			if (code === "POST_TYPE_INVALID" && data?.problems) {
				const found: typeof errors = {};
				for (const problem of data.problems) {
					const at = problem.at === "name" || problem.at === "urlPattern" || problem.at === "key" ? problem.at : "form";
					found[at] = found[at] ? `${found[at]} ${problem.message}` : problem.message;
				}
				setErrors(found);
			} else if (code === "POST_TYPE_TAKEN") {
				setErrors(
					data?.field === "key"
						? { key: t("errors.POST_TYPE_TAKEN_KEY") }
						: { urlPattern: t("errors.POST_TYPE_TAKEN_URL_PATTERN") },
				);
			} else if (code === "PATH_TAKEN") {
				setErrors({ urlPattern: t(errorMessage(failure)) });
			} else {
				setErrors({ form: t(errorMessage(failure)) });
			}
		} finally {
			setBusy(false);
		}
	};

	const input = (
		id: "name" | "urlPattern" | "key",
		label: MessageKey,
		value: string,
		set: (value: string) => void,
		help?: MessageKey,
	) => (
		<Field data-invalid={errors[id] ? true : undefined}>
			<FieldLabel htmlFor={`new-post-type-${id}`}>{t(label)}</FieldLabel>
			<Input
				id={`new-post-type-${id}`}
				value={value}
				onChange={(event) => set(event.target.value)}
				autoComplete="off"
				spellCheck={id === "name"}
				className={id === "name" ? undefined : "font-mono"}
				aria-invalid={errors[id] ? true : undefined}
				aria-describedby={
					[help ? `new-post-type-${id}-help` : null, errors[id] ? `new-post-type-${id}-error` : null]
						.filter(Boolean)
						.join(" ") || undefined
				}
			/>
			{help ? <FieldDescription id={`new-post-type-${id}-help`}>{t(help)}</FieldDescription> : null}
			{errors[id] ? <FieldError id={`new-post-type-${id}-error`}>{errors[id]}</FieldError> : null}
		</Field>
	);

	return (
		<>
			<Button
				ref={trigger}
				type="button"
				variant="ghost"
				size="icon-sm"
				aria-label={t("postTypes.create.open")}
				onClick={() => setOpen(true)}
			>
				<PlusIcon aria-hidden="true" />
			</Button>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) setErrors({});
				}}
			>
				<DialogContent closeLabel={t("postTypes.create.close")} finalFocus={trigger}>
					<form onSubmit={submit} className="grid gap-6" noValidate>
						<DialogHeader>
							<DialogTitle>{t("postTypes.create.title")}</DialogTitle>
							<DialogDescription>{t("postTypes.create.intro")}</DialogDescription>
						</DialogHeader>
						<FieldGroup className="gap-4">
							{input("name", "postTypes.name", name, setName)}
							{input("urlPattern", "postTypes.urlPattern", urlPattern, setUrlPattern, "postTypes.urlPatternHelp")}
							{input("key", "postTypes.create.key", key, setKey, "postTypes.create.keyHelp")}
						</FieldGroup>
						{errors.form ? <FieldError>{errors.form}</FieldError> : null}
						<DialogFooter>
							<DialogClose render={<Button variant="outline" type="button" />}>
								{t("postTypes.create.cancel")}
							</DialogClose>
							<Button type="submit" disabled={busy}>
								{t("postTypes.create.submit")}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
