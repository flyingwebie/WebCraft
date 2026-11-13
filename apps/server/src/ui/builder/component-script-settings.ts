/** Shared Component script settings. Self-contained so Code mode's hashed asset can serialize it. */
export function componentScriptSettings(options: { document: Document; word(key: string): string; changed(): void }) {
	const { document, word } = options;
	const root = document.createElement("div");
	root.className = "pickers grid gap-2 p-2 text-sm";
	const consent = document.createElement("select");
	consent.disabled = true;
	consent.id = `script-consent-${crypto.randomUUID()}`;
	consent.className = "picker rounded border bg-background px-2 py-1";
	const label = document.createElement("label");
	label.htmlFor = consent.id;
	label.textContent = word("consentCategory");
	for (const category of ["necessary", "analytics", "marketing", "media"]) {
		const option = document.createElement("option");
		option.value = category;
		option.textContent = word(`consent${category[0]?.toUpperCase()}${category.slice(1)}`);
		consent.append(option);
	}
	const libraries = document.createElement("div");
	libraries.className = "checks flex flex-wrap gap-2";
	libraries.setAttribute("role", "group");
	libraries.setAttribute("aria-label", word("componentLibraries"));
	root.append(label, consent, libraries);
	root.addEventListener("change", options.changed);
	return {
		root,
		get() {
			return {
				consentCategory: consent.value,
				libraryIds: [...libraries.querySelectorAll<HTMLInputElement>("input:checked")].map((box) => box.value),
			};
		},
		set(input: { consentCategory: string; libraryIds: string[]; libraries: { id: string; name: string }[] }) {
			consent.value = input.consentCategory;
			consent.disabled = false;
			libraries.replaceChildren();
			if (!input.libraries.length) libraries.append(word("noLibraries"));
			for (const library of input.libraries) {
				const label = document.createElement("label");
				label.className = "flex items-center gap-1";
				const box = document.createElement("input");
				box.type = "checkbox";
				box.value = library.id;
				box.checked = input.libraryIds.includes(library.id);
				label.append(box, library.name);
				libraries.append(label);
			}
		},
	};
}
