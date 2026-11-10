import type { SiteCheck } from "@webcraft/core";
import { useEffect, useState } from "react";
import { getApi } from "./api.ts";
import { errorMessage } from "./errors.ts";
import { type MessageKey, useT } from "./i18n.tsx";

type Check = Pick<SiteCheck, "check" | "at" | "detail" | "params"> &
	Partial<Pick<SiteCheck, "href" | "item" | "language">>;
export function Checks({ checks, onSelect }: { checks: readonly Check[]; onSelect?: (at: string) => void }) {
	const t = useT();
	return (
		<section aria-label={t("checks.heading")} className="grid gap-3 rounded-md border p-4 text-sm">
			<h2 className="font-semibold">{t("checks.heading")}</h2>
			<p className="text-muted-foreground">{t("checks.intro")}</p>
			{checks.length === 0 ? (
				<p>{t("checks.empty")}</p>
			) : (
				<ul className="grid gap-3">
					{checks.map((c) => (
						<li key={`${c.item?.id}-${c.language}-${c.check}-${c.at}-${c.detail ?? ""}`} className="grid gap-1">
							<span>
								{t(`${c.check.startsWith("seo") ? "seo.checks" : "checks"}.${c.check}` as MessageKey, c.params ?? {})}
							</span>
							{c.detail ? <span>{c.detail}</span> : null}
							{c.item ? (
								<span className="text-muted-foreground">
									{c.item.templateKind
										? `${t(`checks.items.${c.item.templateKind}`)}${c.item.name ? ` · ${c.item.name}` : ""}`
										: c.item.kind === "designSystem"
											? t("checks.items.designSystem")
											: c.item.name}{" "}
									· {c.language} · {c.at}
								</span>
							) : null}
							{c.href ? (
								<a className="underline underline-offset-4" href={c.href}>
									{t("checks.open")}
								</a>
							) : onSelect && c.at.includes("#") ? (
								<button
									type="button"
									className="text-start underline underline-offset-4"
									onClick={() => onSelect(c.at)}
								>
									{t("checks.open")}
								</button>
							) : null}
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
export function EntryChecks({
	siteId,
	entryId,
	language,
	version,
}: {
	siteId: string;
	entryId: string;
	language: string;
	version: { checks: readonly Pick<SiteCheck, "check" | "at">[] };
}) {
	const t = useT();
	const [checks, setChecks] = useState<SiteCheck[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let current = true;
		void version;
		setError(null);
		getApi()
			.then((api) => api.checks.entry({ siteId, entryId, language }))
			.then((result) => {
				if (current)
					setChecks(
						result.checks.filter(
							(check) => !version.checks.some((existing) => existing.check === check.check && existing.at === check.at),
						),
					);
			})
			.catch((e) => {
				if (current) setError(t(errorMessage(e)));
			});
		return () => {
			current = false;
		};
	}, [siteId, entryId, language, version, t]);
	return error ? (
		<p role="alert">{error}</p>
	) : checks?.length === 0 ? null : checks ? (
		<Checks
			checks={checks.map((check) => ({
				...check,
				href: check.href.startsWith(`/sites/${siteId}/entries/`) ? `#${encodeURIComponent(check.at)}` : check.href,
			}))}
		/>
	) : (
		<p role="status">{t("checks.loading")}</p>
	);
}
