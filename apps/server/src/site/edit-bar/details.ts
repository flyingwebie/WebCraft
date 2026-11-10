import type { BarKit, DetailsPanel, MediaChoice } from "./kit.ts";

/**
 * Page details in Edit mode: a drawer (a bottom sheet on a phone) with the values of the page's Entry
 * that don't show on the page: its title, its address (its slug, after the part of the path before
 * it), its SEO title and description (what the page falls back to shown in each while it is empty),
 * its Summary, its social image (from the Media library), its canonical URL and noindex. Each is in the
 * page's language where it is translatable, and saved to the Draft as it is typed, as the admin's Entry
 * editor saves it: a slug another page has is refused there the same way, and said next to the box.
 *
 * Like the editing bar, this is one self-contained function served as source text (`assets.ts`).
 */
export function pageDetailsPanel(kit: BarKit): DetailsPanel {
	const { win, el, button, icon, word, call, later, cancel } = kit;
	type Seo = {
		title: string | null;
		description: string | null;
		canonical: string | null;
		image: string | null;
		noindex: boolean;
	};
	type Details = {
		item: string;
		language: string;
		title: string;
		address: { prefix: string; slug: string; path: string | null; home: boolean };
		seo: Seo;
		fallbacks: { title: string; description: string | null; image: { mediaId: string; from: string } | null };
		summary: { field: string; label: string; type: string; value: unknown } | null;
		translatable: { title: boolean; slug: boolean; seo: boolean; summary: boolean };
		image: MediaChoice | null;
		published: boolean;
	};
	type Problem = { at: string; rule?: string; message?: string };
	/** What is open: the drawer, how to close it, and the element focus goes back to. */
	let opened: { panel: HTMLElement; close(returnFocus: boolean): void } | null = null;
	const SEO_TITLE_MAX = 60;
	const DESCRIPTION_MAX = 160;

	function isOpen(): boolean {
		return opened !== null;
	}

	function close(returnFocus: boolean): void {
		const was = opened;
		opened = null;
		was?.close(returnFocus);
	}

	async function open(from: HTMLElement | null): Promise<void> {
		close(false);
		const s = kit.state();
		const item = s.page.item;
		if (!item) return;
		const language = s.language;
		const answer = await call("details", { item, language: language.code });
		if (!answer.ok) {
			kit.announce(kit.errorText(answer.code));
			return;
		}
		let details = answer.data as Details;
		const many = s.languages.length > 1;
		const named = (label: string, translatable: boolean) =>
			many && translatable ? word("fieldIn", { label, language: language.name }) : label;
		const titleId = "wc-details-title";
		const panel = el("div", { class: "drawer", role: "dialog", "aria-labelledby": titleId, tabindex: "-1" });
		const status = el("p", { class: "field-status", role: "status" });
		const timers = new Map<string, number>();
		const problemOf = new Map<string, HTMLElement>();

		/** A box with its label, help and the place its problem is said. */
		const field = (
			key: string,
			label: string,
			input: HTMLInputElement | HTMLTextAreaElement | HTMLElement,
			help?: HTMLElement,
		): HTMLElement => {
			const id = `wc-details-${key}`;
			input.id = id;
			const problem = el("p", { class: "field-problem", id: `${id}-problem` });
			problemOf.set(key, problem);
			input.setAttribute("aria-describedby", [help ? `${id}-help` : "", `${id}-problem`].filter(Boolean).join(" "));
			if (help) help.id = `${id}-help`;
			return el(
				"div",
				{ class: "field" },
				el("label", { for: id, class: "field-label" }, label),
				input,
				...(help ? [help] : []),
				problem,
			);
		};

		/** Where a box's value is, as problems name it. */
		const pathOf = (key: string): string => {
			if (key === "summary") return details.summary ? `fields.${details.summary.field}` : "";
			if (key === "title" || key === "slug") return key;
			return `seo.${key === "title-seo" ? "title" : key}`;
		};
		const showProblems = (problems: Problem[], keys: string[]) => {
			for (const key of keys) {
				const found = problems.find((problem) => problem.at === pathOf(key));
				const message = problemOf.get(key);
				if (!message) continue;
				message.textContent = found ? kit.problemText(found) : "";
				message.parentElement?.querySelector("input, textarea")?.setAttribute("aria-invalid", found ? "true" : "false");
			}
		};

		/** Saves one value a moment after it stops changing (at once with `wait` 0). */
		const save = (key: string, change: Record<string, unknown>, wait = 800) => {
			cancel(timers.get(key));
			timers.set(
				key,
				later(async () => {
					status.textContent = word("saving");
					const saved = await call("details/save", { item, language: language.code, ...change });
					if (!saved.ok) {
						const message = problemOf.get(key);
						if (message) message.textContent = kit.errorText(saved.code);
						message?.parentElement?.querySelector("input, textarea")?.setAttribute("aria-invalid", "true");
						status.textContent = word("saveFailed", { reason: kit.errorText(saved.code) });
						return;
					}
					const data = saved.data as { details: Details; problems: Problem[] };
					details = data.details;
					// A page never published is found at its Draft's address: it moves with its slug.
					if (key === "slug" && !details.published && details.address.path) kit.moved(details.address.path);
					showProblems(data.problems, [key]);
					update();
					status.textContent = word("saved");
					await kit.refresh();
				}, wait),
			);
		};

		// The title and the address.
		const title = el("input", { type: "text", class: "text-input", autocomplete: "off", maxlength: "2000" });
		title.value = details.title;
		title.addEventListener("input", () => save("title", { title: title.value }));
		const slug = el("input", { type: "text", class: "text-input", autocomplete: "off", spellcheck: "false" });
		slug.value = details.address.slug;
		slug.addEventListener("input", () => save("slug", { slug: slug.value }));
		const prefix = el("span", { class: "address-prefix" });
		const addressHelp = el("p", { class: "help" });
		const address = field("slug", named(word("address"), true), slug, addressHelp);
		// The part of the address before the slug shows in front of it.
		const addressRow = el("div", { class: "address-row" }, prefix);
		slug.before(addressRow);
		addressRow.append(slug);

		// Search and sharing.
		const seoTitle = el("input", { type: "text", class: "text-input", autocomplete: "off", maxlength: "2000" });
		seoTitle.value = details.seo.title ?? "";
		const seoTitleCount = el("p", { class: "help" });
		seoTitle.addEventListener("input", () => {
			count();
			save("title-seo", { seo: { title: seoTitle.value } });
		});
		const description = el("textarea", { class: "text-input", rows: "3", maxlength: "2000" });
		description.value = details.seo.description ?? "";
		const descriptionCount = el("p", { class: "help" });
		description.addEventListener("input", () => {
			count();
			save("description", { seo: { description: description.value } });
		});
		const canonical = el("input", { type: "url", class: "text-input", autocomplete: "off" });
		canonical.value = details.seo.canonical ?? "";
		canonical.addEventListener("input", () => save("canonical", { seo: { canonical: canonical.value } }));
		const noindex = button({ class: "switch", role: "switch", "aria-checked": String(details.seo.noindex) });
		noindex.addEventListener("click", () => {
			const next = noindex.getAttribute("aria-checked") !== "true";
			noindex.setAttribute("aria-checked", String(next));
			save("noindex", { seo: { noindex: next } }, 0);
		});

		const count = () => {
			const titleLength = [...(seoTitle.value || details.fallbacks.title)].length;
			seoTitleCount.textContent = word("counter", { count: titleLength, max: SEO_TITLE_MAX });
			const descriptionLength = [...(description.value || details.fallbacks.description || "")].length;
			descriptionCount.textContent = word("counter", { count: descriptionLength, max: DESCRIPTION_MAX });
		};

		// The Summary: text, or rich text; a body's start can't be changed here.
		let summaryBlock: HTMLElement | null = null;
		if (details.summary) {
			const summary = details.summary;
			const label = named(summary.label, details.translatable.summary);
			if (summary.type === "text") {
				const box = el("textarea", { class: "text-input", rows: "3" });
				box.value = typeof summary.value === "string" ? summary.value : "";
				box.addEventListener("input", () => save("summary", { summary: box.value }));
				summaryBlock = field("summary", label, box);
			} else if (summary.type === "richText") {
				const box = el("div", {
					class: "rich-input",
					role: "textbox",
					"aria-multiline": "true",
					contenteditable: "true",
					"aria-labelledby": "wc-details-summary-label",
				});
				box.replaceChildren(...kit.richText(typeof summary.value === "string" ? summary.value : ""));
				box.addEventListener("input", () => save("summary", { summary: box.innerHTML }));
				const problem = el("p", { class: "field-problem", id: "wc-details-summary-problem" });
				problemOf.set("summary", problem);
				box.setAttribute("aria-describedby", "wc-details-summary-problem");
				summaryBlock = el(
					"div",
					{ class: "field" },
					el("span", { id: "wc-details-summary-label", class: "field-label" }, label),
					box,
					problem,
				);
			} else {
				summaryBlock = el(
					"div",
					{ class: "field" },
					el("span", { class: "field-label" }, label),
					el("p", { class: "help" }, word("summaryInBody")),
				);
			}
		}

		// The social image.
		const image = el("div", { class: "media-row" });
		const imageLabelId = "wc-details-image-label";
		const drawImage = () => {
			const own = details.seo.image;
			const from = own ? "entry" : details.fallbacks.image?.from;
			const shown = details.image;
			const change = button({ class: "secondary small", "aria-describedby": imageLabelId }, word("change"));
			change.addEventListener("click", async () => {
				const picked = await kit.pickImage({ title: word("socialImage"), current: own, from: change });
				if (picked) save("image", { seo: { image: picked.id } }, 0);
			});
			const children: Node[] = [];
			if (shown?.thumbnail) children.push(el("img", { src: shown.thumbnail, alt: "", class: "media-thumb" }));
			children.push(
				el(
					"span",
					{ class: "media-name" },
					from === "entry"
						? word("imageOwn")
						: from === "field"
							? word("imageFromField")
							: from === "site"
								? word("imageFromSite")
								: word("imageNone"),
				),
				change,
			);
			if (own) {
				const reset = button({ class: "link-button" }, word("useFallbackImage"));
				reset.addEventListener("click", () => save("image", { seo: { image: null } }, 0));
				children.push(reset);
			}
			image.replaceChildren(...children);
		};
		const imageProblem = el("p", { class: "field-problem" });
		problemOf.set("image", imageProblem);

		/** Shows what saving changed: the fallbacks, the counters, the address and the image. */
		const update = () => {
			seoTitle.placeholder = details.fallbacks.title;
			description.placeholder = details.fallbacks.description ?? "";
			canonical.placeholder = details.address.path ? `${win.location.origin}${details.address.path}` : "";
			prefix.textContent = `${win.location.host}${details.address.home ? "/" : details.address.prefix}`;
			slug.readOnly = details.address.home;
			addressHelp.textContent = details.address.home ? word("homeAddress") : word("addressHelp");
			count();
			drawImage();
		};

		const closeButton = button({ class: "icon-button", "aria-label": word("close") }, icon("close"));
		const content: HTMLElement[] = [
			el("p", { class: "help intro" }, word("detailsIntro")),
			field("title", named(word("builtIns.title"), true), title),
			address,
			el("h3", { class: "drawer-section" }, word("searchAndSharing")),
			field("title-seo", named(word("seoTitle"), true), seoTitle, seoTitleCount),
			field("description", named(word("metaDescription"), true), description, descriptionCount),
			...(summaryBlock ? [summaryBlock] : []),
			el(
				"div",
				{ class: "field" },
				el("span", { id: imageLabelId, class: "field-label" }, named(word("socialImage"), true)),
				image,
				imageProblem,
			),
			field("canonical", named(word("canonical"), true), canonical, el("p", { class: "help" }, word("canonicalHelp"))),
			el(
				"div",
				{ class: "field switch-field" },
				el("label", { for: "wc-details-noindex", class: "field-label" }, word("noindex")),
				noindex,
				el("p", { class: "help", id: "wc-details-noindex-help" }, word("noindexHelp")),
			),
			status,
		];
		noindex.id = "wc-details-noindex";
		noindex.setAttribute("aria-describedby", "wc-details-noindex-help");
		update();

		let sheet: ReturnType<BarKit["sheet"]> | null = null;
		const state = {
			panel,
			close(returnFocus: boolean) {
				for (const timer of timers.values()) cancel(timer);
				win.document.documentElement.classList.remove("wc-edit-drawer");
				if (sheet) {
					const was = sheet;
					sheet = null;
					was.close();
				} else panel.remove();
				if (returnFocus && from?.isConnected) from.focus();
			},
		};
		opened = state;
		closeButton.addEventListener("click", () => close(true));
		panel.addEventListener("keydown", (event) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			close(true);
		});
		if (kit.phone()) {
			panel.className = "sheet-body";
			panel.removeAttribute("role");
			panel.append(...content);
			sheet = kit.sheet({
				title: word("pageDetails"),
				from,
				content: panel,
				onClose: () => {
					if (opened === state) {
						opened = null;
						state.close(false);
					}
				},
			});
		} else {
			panel.append(
				el(
					"div",
					{ class: "panel-head" },
					el("h2", { id: titleId, class: "panel-title" }, icon("details"), word("pageDetails")),
					closeButton,
				),
				el("div", { class: "drawer-body" }, ...content),
			);
			kit.layer.append(panel);
			win.document.documentElement.classList.add("wc-edit-drawer");
			panel.focus();
		}
	}

	return { open: (from) => void open(from), close, isOpen };
}
