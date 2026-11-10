import type { BarKit, ImageTools, MediaChoice, PanelHandle, PresenceTarget } from "./kit.ts";

/**
 * Images in Edit mode: an image region (an `<img>` whose `src` is a media Field, or a body's image
 * Block) opens the image popover on a click, Enter or Space. There a new image is chosen from the
 * Site's Media library (search, folders) or uploaded (the button, or a file dropped on the image or
 * the library), its alt text written in each language (with the AI's suggestion where the Workspace
 * has an AI key), and its Focal point dragged on the image or moved with the arrow keys, its value
 * shown. The image goes to the Draft; alt text and the Focal point are the Media item's own, live at
 * once on every page showing it, as in the Media library.
 *
 * Like the editing bar, this is one self-contained function served as source text (`assets.ts`):
 * it uses nothing but its kit.
 */
export function imageTools(kit: BarKit): ImageTools {
	const { doc, el, button, icon, word, call, later, cancel } = kit;
	const known = new WeakSet<HTMLElement>();
	let regions: HTMLElement[] = [];
	let on = false;
	let opened: { region: HTMLElement; handle: PanelHandle } | null = null;
	/** An image region on the page. */
	const REGION = '[data-wc-type="media"][data-wc-item][data-wc-field]';
	const POLL_MS = 1000;
	const POLL_TIMES = 120;

	function labelOf(region: HTMLElement): string {
		return region.dataset.wcLabel ?? word("types.media");
	}

	function tagText(region: HTMLElement): string {
		return word("regionTag", { label: labelOf(region), type: word("types.image") });
	}

	function hasFiles(event: DragEvent): boolean {
		return [...(event.dataTransfer?.types ?? [])].includes("Files");
	}

	/** Whether the region sits inside a control whose content can't hold another one (a button). */
	function insideButton(region: HTMLElement): boolean {
		return Boolean(region.parentElement?.closest("button, [role='button']"));
	}

	function applyTo(region: HTMLElement): void {
		const name = word("imageRegion", { label: labelOf(region) });
		if (on) {
			region.tabIndex = 0;
			if (!insideButton(region)) region.setAttribute("role", "button");
			region.setAttribute("aria-haspopup", "dialog");
			region.setAttribute("aria-label", name);
			if (region.tagName !== "IMG") region.setAttribute("data-wc-empty-label", word("chooseImage"));
			// A decorative image (empty alt text) is no control; while it is one here it says what it does.
			if (region.getAttribute("alt") === "") {
				region.setAttribute("data-wc-decorative", "");
				region.setAttribute("alt", name);
			}
		} else {
			for (const attribute of ["tabindex", "role", "aria-haspopup", "aria-label"]) region.removeAttribute(attribute);
			if (region.hasAttribute("data-wc-decorative")) {
				region.removeAttribute("data-wc-decorative");
				region.setAttribute("alt", "");
			}
		}
	}

	function setUp(scope: ParentNode): void {
		regions = regions.filter((region) => region.isConnected);
		for (const region of scope.querySelectorAll<HTMLElement>(REGION)) {
			if (known.has(region)) continue;
			known.add(region);
			regions.push(region);
			region.addEventListener("click", (event) => {
				if (!on) return;
				// An image inside a link changes the image here; it never follows the link.
				event.preventDefault();
				event.stopPropagation();
				open(region);
			});
			region.addEventListener("keydown", (event) => {
				if (!on || (event.key !== "Enter" && event.key !== " ")) return;
				event.preventDefault();
				open(region);
			});
			region.addEventListener("mouseenter", () => {
				if (on) kit.showTag(region, tagText(region));
			});
			region.addEventListener("mouseleave", () => {
				if (opened?.region !== region) kit.showTag(null);
			});
			region.addEventListener("focus", () => {
				if (on) kit.showTag(region, tagText(region));
			});
			region.addEventListener("blur", () => {
				if (opened?.region !== region) kit.showTag(null);
			});
			region.addEventListener("dragover", (event) => {
				if (!on || !hasFiles(event)) return;
				event.preventDefault();
				region.setAttribute("data-wc-drop", "");
			});
			region.addEventListener("dragleave", () => region.removeAttribute("data-wc-drop"));
			region.addEventListener("drop", (event) => {
				region.removeAttribute("data-wc-drop");
				const file = event.dataTransfer?.files[0];
				if (!on || !file) return;
				event.preventDefault();
				void uploadInto(region, file);
			});
			applyTo(region);
		}
	}

	function mode(next: boolean): void {
		on = next;
		regions = regions.filter((region) => region.isConnected);
		for (const region of regions) applyTo(region);
		if (!on) close();
	}

	function targets(): PresenceTarget[] {
		return regions
			.filter((region) => region.isConnected)
			.map((region) => ({
				item: region.dataset.wcItem ?? "",
				at: (region.dataset.wcField ?? "").split(".")[0] ?? "",
				rect: () => region.getBoundingClientRect(),
				outline: region,
			}));
	}

	function close(returnFocus = false): void {
		const was = opened;
		if (!was) return;
		opened = null;
		was.handle.close(returnFocus);
	}

	// -------------------------------------------------------------------------------------------
	// Talking to the library

	type Loaded = { media: MediaChoice; altTextSuggestions: boolean };

	async function loadMedia(mediaId: string, language: string): Promise<Loaded | null> {
		const answer = await call("media/get", { media: mediaId, language });
		return answer.ok ? (answer.data as Loaded) : null;
	}

	/** Waits until the worker has cleaned an upload (or refused it): the item as it is then. */
	async function readyMedia(media: MediaChoice, say: (text: string) => void): Promise<MediaChoice | null> {
		let current = media;
		for (let tries = 0; current.status === "processing" && tries < POLL_TIMES; tries++) {
			say(word("preparing", { name: current.fileName }));
			await new Promise<void>((resolve) => later(resolve, POLL_MS));
			const loaded = await loadMedia(current.id, kit.state().language.code);
			if (loaded) current = loaded.media;
		}
		if (current.status !== "ready") {
			say(word("uploadFailed", { name: current.fileName }));
			return null;
		}
		return current;
	}

	/** Uploads a file to the library and waits until it is ready: null (and why, said) when it isn't taken. */
	async function uploadFile(file: File, say: (text: string) => void): Promise<MediaChoice | null> {
		say(word("uploading", { name: file.name }));
		const answer = await kit.upload(file);
		if (!answer.ok) {
			say(kit.errorText(answer.code));
			return null;
		}
		return readyMedia((answer.data as { media: MediaChoice }).media, say);
	}

	// -------------------------------------------------------------------------------------------
	// Choosing an image for a region

	/** The region in `root` that is the same as `region`: the same item, Field, element and Block. */
	function sameRegion(root: ParentNode, region: HTMLElement): HTMLElement | undefined {
		const { wcItem, wcField, wcId, wcBlock } = region.dataset;
		return [...root.querySelectorAll<HTMLElement>(REGION)].find(
			(candidate) =>
				candidate.dataset.wcItem === wcItem &&
				candidate.dataset.wcField === wcField &&
				candidate.dataset.wcId === wcId &&
				candidate.dataset.wcBlock === wcBlock,
		);
	}

	/** The page's images showing a Media item (tagged regions). */
	function imagesOf(mediaId: string): HTMLImageElement[] {
		return [...doc.querySelectorAll<HTMLImageElement>("img[data-wc-media]")].filter(
			(image) => image.dataset.wcMedia === mediaId,
		);
	}

	/** The element a region stands for on the page: its `<picture>` when it has one. */
	function outer(region: Element): Element {
		return region.parentElement?.tagName === "PICTURE" ? region.parentElement : region;
	}

	/**
	 * Shows the region as the page has it now, read again from the server (new image, new sizes, new
	 * Focal point classes): answers the region that took its place.
	 */
	async function refreshRegion(region: HTMLElement): Promise<HTMLElement> {
		const fresh = await kit.freshPage();
		const found = fresh ? sameRegion(fresh, region) : undefined;
		if (!found) return region;
		const replacement = doc.importNode(outer(found), true) as Element;
		outer(region).replaceWith(replacement);
		const next = replacement.matches(REGION)
			? (replacement as HTMLElement)
			: replacement.querySelector<HTMLElement>(REGION);
		kit.adopt([replacement]);
		setUp(replacement.parentElement ?? doc);
		return next ?? region;
	}

	async function choose(region: HTMLElement, mediaId: string | null): Promise<HTMLElement | null> {
		const answer = await call("image", {
			item: region.dataset.wcItem,
			field: region.dataset.wcField,
			...(region.dataset.wcBlock ? { block: region.dataset.wcBlock } : {}),
			media: mediaId,
			language: kit.state().language.code,
		});
		if (!answer.ok) {
			kit.announce(word("saveFailed", { reason: kit.errorText(answer.code) }));
			return null;
		}
		const next = await refreshRegion(region);
		kit.announce(mediaId ? word("imageChanged") : word("imageRemoved"));
		await kit.refresh();
		return next;
	}

	async function uploadInto(region: HTMLElement, file: File): Promise<void> {
		const uploaded = await uploadFile(file, kit.announce);
		if (!uploaded) return;
		const next = await choose(region, uploaded.id);
		if (next && opened) open(next);
	}

	// -------------------------------------------------------------------------------------------
	// The image popover

	function open(region: HTMLElement): void {
		close();
		const status = el("p", { class: "field-status", role: "status" });
		const say = (text: string) => {
			status.textContent = text;
		};
		let timers: number[] = [];
		// Assigned once `kit.panel` returns, before any of these handlers can run.
		let handle: PanelHandle;
		const fileInput = el("input", {
			type: "file",
			accept: "image/jpeg,image/png,image/webp,image/avif,image/gif,image/heic,image/heif,image/svg+xml",
			class: "sr-only",
			tabindex: "-1",
			"aria-hidden": "true",
		});
		fileInput.addEventListener("change", () => {
			const file = fileInput.files?.[0];
			if (file) void uploadInto(region, file);
		});
		const chooseButton = button({ class: "secondary" }, icon("library"), word("chooseFromMedia"));
		chooseButton.addEventListener("click", async () => {
			// The library takes the popover's place while it is open; the popover comes back after.
			handle.panel.hidden = true;
			const picked = await pick({
				title: labelOf(region),
				current: region.dataset.wcMedia ?? null,
				from: chooseButton,
			});
			if (opened?.handle !== handle) return;
			handle.panel.hidden = false;
			if (!picked) {
				chooseButton.focus();
				return;
			}
			const next = await choose(region, picked.id);
			if (next) open(next);
		});
		const uploadButton = button({ class: "secondary" }, icon("upload"), word("upload"));
		uploadButton.addEventListener("click", () => fileInput.click());
		const actions = el("div", { class: "image-actions" }, chooseButton, uploadButton, fileInput);
		const mediaId = region.dataset.wcMedia;
		if (mediaId) {
			const remove = button({ class: "link-button" }, word("removeImage"));
			remove.addEventListener("click", async () => {
				const next = await choose(region, null);
				if (next) open(next);
			});
			actions.append(remove);
		}
		const body = el("div", { class: "image-body" });

		handle = kit.panel({
			title: labelOf(region),
			headIcon: "image",
			className: "popup dialog image-popover",
			content: () => [actions, body, status],
			anchor: () => region.getBoundingClientRect(),
			onClose: () => {
				for (const timer of timers) cancel(timer);
				timers = [];
				kit.placeIn(null);
				kit.showTag(null);
			},
			focusBack: () => {
				if (region.isConnected) region.focus();
			},
		});
		opened = { region, handle };
		kit.placeIn({ item: region.dataset.wcItem ?? "", at: (region.dataset.wcField ?? "").split(".")[0] ?? "" });

		handle.panel.addEventListener("dragover", (event) => {
			if (hasFiles(event)) event.preventDefault();
		});
		handle.panel.addEventListener("drop", (event) => {
			const file = event.dataTransfer?.files[0];
			if (!file) return;
			event.preventDefault();
			void uploadInto(region, file);
		});
		if (!kit.phone()) {
			handle.panel.addEventListener("focusout", (event) => {
				const next = (event as FocusEvent).relatedTarget;
				// The Media library opened from here keeps the popover for when it closes.
				if (handle.panel.hidden) return;
				if (opened?.handle === handle && next instanceof Node && !handle.panel.contains(next) && next !== region) {
					close(false);
				}
			});
		}
		handle.panel.focus();
		if (mediaId) void renderImage(handle, body, mediaId, say, (timer) => timers.push(timer));
	}

	/** The popover's alt text, Focal point and size for the image the region shows. */
	async function renderImage(
		handle: PanelHandle,
		body: HTMLElement,
		mediaId: string,
		say: (text: string) => void,
		keep: (timer: number) => void,
	): Promise<void> {
		const s = kit.state();
		let language = s.language.code;
		let loaded = await loadMedia(mediaId, language);
		if (!loaded || opened?.handle !== handle) return;
		const media = loaded.media;
		const altId = "wc-image-alt";
		const altInput = el("input", {
			id: altId,
			type: "text",
			class: "text-input",
			maxlength: "1000",
			autocomplete: "off",
		});
		altInput.value = media.alt ?? "";
		let savedAlt = altInput.value;
		const altLabel = el("label", { for: altId, class: "field-label" });
		const describeLanguage = () => {
			const name = s.languages.find((choice) => choice.code === language)?.name ?? language;
			altLabel.textContent = word("altText", { language: name });
		};
		describeLanguage();
		let altTimer = 0;
		const saveAlt = async () => {
			cancel(altTimer);
			if (altInput.value === savedAlt) return;
			const value = altInput.value;
			const answer = await call("media/update", { media: mediaId, language, alt: value });
			if (!answer.ok) {
				say(word("saveFailed", { reason: kit.errorText(answer.code) }));
				return;
			}
			savedAlt = value;
			// The page shows the library's alt text where its Template gives none.
			for (const image of imagesOf(mediaId)) {
				if (language === s.language.code && image.alt === (media.alt ?? "")) image.alt = value;
			}
			media.alt = value;
			say(word("altSaved"));
		};
		altInput.addEventListener("input", () => {
			cancel(altTimer);
			altTimer = later(() => void saveAlt(), 800);
			keep(altTimer);
		});
		altInput.addEventListener("blur", () => void saveAlt());
		const altHead = el("div", { class: "field-head" }, altLabel);
		if (s.languages.length > 1) {
			const pickId = "wc-image-alt-language";
			const select = el("select", { id: pickId, class: "small-select" });
			for (const choice of s.languages) {
				const option = el("option", { value: choice.code }, choice.name);
				option.selected = choice.code === language;
				select.append(option);
			}
			select.addEventListener("change", async () => {
				await saveAlt();
				language = select.value;
				loaded = await loadMedia(mediaId, language);
				altInput.value = loaded?.media.alt ?? "";
				savedAlt = altInput.value;
				describeLanguage();
			});
			altHead.append(el("label", { for: pickId, class: "sr-only" }, word("altLanguage")), select);
		}
		const altBlock = el("div", { class: "field" }, altHead, altInput, el("p", { class: "help" }, word("altHelp")));
		if (loaded.altTextSuggestions && media.canEdit) {
			const suggest = button({ class: "secondary small" }, icon("sparkles"), word("suggestAlt"));
			suggest.addEventListener("click", async () => {
				suggest.disabled = true;
				say(word("suggesting"));
				const answer = await call("media/suggestAlt", { media: mediaId, language });
				suggest.disabled = false;
				if (!answer.ok) {
					say(kit.errorText(answer.code));
					return;
				}
				// Only a suggestion: the person reads it; it is saved once they move on.
				altInput.value = (answer.data as { alt: string }).alt;
				altInput.focus();
				altInput.select();
				say(word("suggested"));
			});
			altHead.append(suggest);
		}
		if (!media.canEdit) {
			altInput.readOnly = true;
			altBlock.append(el("p", { class: "help" }, word("notYours")));
		}
		body.replaceChildren(altBlock);
		if (media.url) body.append(focalBlock(media, say, keep));
		const size =
			media.width && media.height ? `${word("imageSize", { width: media.width, height: media.height })} · ` : "";
		body.append(el("p", { class: "help info" }, icon("info"), `${size}${word("servedAs")}`));
		handle.reposition();
	}

	/**
	 * The Focal point: the image with a dot on it, dragged with a pointer or moved with the arrow keys
	 * (Shift for bigger steps), its value said and shown; saved a moment after it stops moving.
	 */
	function focalBlock(media: MediaChoice, say: (text: string) => void, keep: (timer: number) => void): HTMLElement {
		let point = media.focalPoint ?? { x: 50, y: 50 };
		let set = media.focalPoint !== null;
		const value = el("p", { class: "help focal-value" });
		const preview = el("img", { src: media.thumbnail ?? media.url ?? "", alt: "", class: "focal-image" });
		const dot = el("div", {
			class: "focal-dot",
			role: "slider",
			tabindex: media.canEdit ? "0" : "-1",
			"aria-label": word("focalPoint"),
			"aria-valuemin": "0",
			"aria-valuemax": "100",
			"aria-orientation": "horizontal",
			"aria-keyshortcuts": "ArrowLeft ArrowRight ArrowUp ArrowDown",
		});
		if (!media.canEdit) dot.setAttribute("aria-disabled", "true");
		const frame = el("div", { class: "focal-frame" }, preview, dot);
		const show = () => {
			dot.style.left = `${point.x}%`;
			dot.style.top = `${point.y}%`;
			const at = word("focalAt", { x: point.x, y: point.y });
			dot.setAttribute("aria-valuenow", String(point.x));
			dot.setAttribute("aria-valuetext", at);
			value.textContent = set ? at : word("focalNone");
		};
		let timer = 0;
		const save = async (next: { x: number; y: number } | null) => {
			cancel(timer);
			const answer = await call("media/update", { media: media.id, focalPoint: next });
			if (!answer.ok) {
				say(word("saveFailed", { reason: kit.errorText(answer.code) }));
				return;
			}
			applyFocal(media.id, next);
			say(next ? word("focalSaved", { at: word("focalAt", next) }) : word("focalCleared"));
		};
		const moveTo = (next: { x: number; y: number }, wait: number) => {
			point = { x: Math.max(0, Math.min(100, Math.round(next.x))), y: Math.max(0, Math.min(100, Math.round(next.y))) };
			set = true;
			show();
			cancel(timer);
			timer = later(() => void save(point), wait);
			keep(timer);
		};
		dot.addEventListener("keydown", (event) => {
			if (!media.canEdit) return;
			const step = event.shiftKey ? 10 : 1;
			const moves: Record<string, [number, number]> = {
				ArrowLeft: [-step, 0],
				ArrowRight: [step, 0],
				ArrowUp: [0, -step],
				ArrowDown: [0, step],
			};
			const move = moves[event.key];
			if (!move) return;
			event.preventDefault();
			moveTo({ x: point.x + move[0], y: point.y + move[1] }, 600);
		});
		const fromPointer = (event: PointerEvent) => {
			const box = preview.getBoundingClientRect();
			if (box.width === 0 || box.height === 0) return;
			moveTo(
				{ x: ((event.clientX - box.left) / box.width) * 100, y: ((event.clientY - box.top) / box.height) * 100 },
				400,
			);
		};
		frame.addEventListener("pointerdown", (event) => {
			if (!media.canEdit) return;
			event.preventDefault();
			frame.setPointerCapture(event.pointerId);
			dot.focus();
			fromPointer(event);
			const moving = (move: PointerEvent) => fromPointer(move);
			const done = () => {
				frame.removeEventListener("pointermove", moving);
				frame.removeEventListener("pointerup", done);
				frame.removeEventListener("pointercancel", done);
			};
			frame.addEventListener("pointermove", moving);
			frame.addEventListener("pointerup", done);
			frame.addEventListener("pointercancel", done);
		});
		const reset = button({ class: "link-button" }, word("focalReset"));
		reset.addEventListener("click", () => {
			point = { x: 50, y: 50 };
			set = false;
			show();
			void save(null);
		});
		show();
		const head = el(
			"div",
			{ class: "field-head" },
			el("span", { class: "field-label" }, icon("focus"), word("focalPoint")),
		);
		if (media.canEdit) head.append(reset);
		return el(
			"div",
			{ class: "field" },
			head,
			el("p", { class: "help" }, word(media.canEdit ? "focalHelp" : "focalReadOnly")),
			frame,
			value,
		);
	}

	/** Gives the page's images of a Media item their new Focal point classes, as the renderer writes them. */
	function applyFocal(mediaId: string, point: { x: number; y: number } | null): void {
		const step = (value: number) => Math.min(100, Math.max(0, Math.round(value / 5) * 5));
		for (const image of imagesOf(mediaId)) {
			for (const name of [...image.classList]) {
				if (name === "wc-focus" || /^wc-f[xy]-\d+$/.test(name)) image.classList.remove(name);
			}
			if (point) image.classList.add("wc-focus", `wc-fx-${step(point.x)}`, `wc-fy-${step(point.y)}`);
		}
	}

	// -------------------------------------------------------------------------------------------
	// The Media library: choose an image, or upload one

	type Library = { items: MediaChoice[]; total: number; folders: { id: string; name: string; count: number }[] };

	function pick(options: {
		title: string;
		current: string | null;
		from: HTMLElement | null;
	}): Promise<MediaChoice | null> {
		return new Promise((resolve) => {
			let chosen: MediaChoice | null = null;
			const titleId = "wc-picker-title";
			const dialog = el("dialog", { class: "picker", "aria-labelledby": titleId });
			const status = el("p", { class: "field-status", role: "status" });
			const say = (text: string) => {
				status.textContent = text;
			};
			const closeButton = button({ class: "icon-button", "aria-label": word("close") }, icon("close"));
			closeButton.addEventListener("click", () => dialog.close());
			const searchId = "wc-picker-search";
			const search = el("input", { id: searchId, type: "search", class: "text-input", autocomplete: "off" });
			const folderId = "wc-picker-folder";
			const folder = el("select", { id: folderId, class: "small-select" });
			const fileInput = el("input", {
				type: "file",
				accept: "image/jpeg,image/png,image/webp,image/avif,image/gif,image/heic,image/heif,image/svg+xml",
				class: "sr-only",
				tabindex: "-1",
				"aria-hidden": "true",
			});
			const uploadButton = button({ class: "secondary" }, icon("upload"), word("upload"));
			uploadButton.addEventListener("click", () => fileInput.click());
			const takeUpload = async (file: File) => {
				const uploaded = await uploadFile(file, say);
				if (!uploaded) return;
				chosen = uploaded;
				dialog.close();
			};
			fileInput.addEventListener("change", () => {
				const file = fileInput.files?.[0];
				if (file) void takeUpload(file);
			});
			const grid = el("ul", { class: "picker-grid", "aria-label": word("pickerImages") });
			const more = button({ class: "secondary" }, word("loadMore"));
			const items: MediaChoice[] = [];
			let total = 0;
			let folders: Library["folders"] = [];
			const load = async (reset: boolean) => {
				const answer = await call("media/list", {
					search: search.value.trim() || undefined,
					folderId: folder.value || undefined,
					offset: reset ? 0 : items.length,
					language: kit.state().language.code,
				});
				if (!answer.ok) {
					say(kit.errorText(answer.code));
					return;
				}
				const library = answer.data as Library;
				if (reset) items.length = 0;
				items.push(...library.items);
				total = library.total;
				if (folders.length === 0 && library.folders.length > 0) {
					folders = library.folders;
					folder.replaceChildren(
						el("option", { value: "" }, word("allFolders")),
						el("option", { value: "none" }, word("noFolder")),
						...folders.map((each) => el("option", { value: each.id }, each.name)),
					);
				}
				renderGrid();
				say(total === 0 ? word("noImages") : total === 1 ? word("imagesOne") : word("imagesOther", { count: total }));
			};
			const renderGrid = () => {
				grid.replaceChildren(
					...items.map((item) => {
						const name = item.alt ? `${item.fileName}, ${item.alt}` : item.fileName;
						const choice = button(
							{
								class: "picker-item",
								"aria-label": item.status === "ready" ? name : `${name}, ${word("processing")}`,
								...(item.id === options.current ? { "aria-current": "true" } : {}),
							},
							item.thumbnail
								? el("img", { src: item.thumbnail, alt: "", loading: "lazy" })
								: el("span", { class: "picker-empty" }),
							el("span", { class: "picker-name" }, item.fileName),
						);
						choice.disabled = item.status !== "ready";
						choice.addEventListener("click", () => {
							chosen = item;
							dialog.close();
						});
						return el("li", {}, choice);
					}),
				);
				more.hidden = items.length >= total;
			};
			let searchTimer = 0;
			search.addEventListener("input", () => {
				cancel(searchTimer);
				searchTimer = later(() => void load(true), 300);
			});
			folder.addEventListener("change", () => void load(true));
			more.addEventListener("click", () => void load(false));
			dialog.addEventListener("dragover", (event) => {
				if (!hasFiles(event)) return;
				event.preventDefault();
				dialog.setAttribute("data-wc-drop", "");
			});
			dialog.addEventListener("dragleave", () => dialog.removeAttribute("data-wc-drop"));
			dialog.addEventListener("drop", (event) => {
				dialog.removeAttribute("data-wc-drop");
				const file = event.dataTransfer?.files[0];
				if (!file) return;
				event.preventDefault();
				void takeUpload(file);
			});
			folder.append(el("option", { value: "" }, word("allFolders")));
			dialog.append(
				el(
					"div",
					{ class: "panel-head" },
					el(
						"h2",
						{ id: titleId, class: "panel-title" },
						icon("library"),
						word("pickerTitle", { label: options.title }),
					),
					closeButton,
				),
				el(
					"div",
					{ class: "picker-tools" },
					el("label", { for: searchId, class: "sr-only" }, word("searchImages")),
					search,
					el("label", { for: folderId, class: "sr-only" }, word("folder")),
					folder,
					uploadButton,
					fileInput,
				),
				el("p", { class: "help" }, word("dropHint")),
				status,
				grid,
				el("div", { class: "picker-more" }, more),
			);
			search.setAttribute("placeholder", word("searchImages"));
			dialog.addEventListener("close", () => {
				cancel(searchTimer);
				dialog.remove();
				if (options.from?.isConnected) options.from.focus();
				resolve(chosen);
			});
			kit.layer.append(dialog);
			dialog.showModal();
			search.focus();
			void load(true);
		});
	}

	const tools: ImageTools = { setUp, mode, targets, pick, open, close: () => close(false) };
	return tools;
}
