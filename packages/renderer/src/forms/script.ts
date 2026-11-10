/**
 * The forms script (GLOSSARY.md › Form). Site pages never carry inline scripts (ADR 0023), so it is a
 * file of its own, named by the hash of what it holds, served from the Site's domain and linked only
 * from pages showing a Form. It is WebCraft's own and Necessary under consent: it only helps send a
 * Form the visitor asked to send. Without it every Form still works: every step shows on one page,
 * the browser posts it, and the server checks it and answers with the page again or a redirect.
 *
 * With it:
 * - **Conditions** show and hide fields, sections and steps as the visitor fills the Form in, by the
 *   same rules the server reads (`formLogic`, whose very code this file carries). What they hide is
 *   disabled, so it is neither checked nor sent.
 * - **Steps** show one at a time, with their progress ("Step 2 of 3") and Back and Next buttons the
 *   page holds for it; Next checks the step first.
 * - **Checks** run as the server's do before anything is sent: each error is shown next to its field
 *   (linked with `aria-describedby`, the field `aria-invalid`), focus goes to the first, and a live
 *   region says how many there are.
 * - **Sending** is a `fetch` of the same post (files included), answered in JSON: the Form's message
 *   takes its place (focused, a status), or the visitor goes on to the Form's Page; the server's errors
 *   show as the script's own. Anything else (a refusal, no answer) posts the Form as the browser would.
 *
 * It reads the Form's rules from `data-wc-rules` (data, never code), writes words with `textContent`
 * only, and builds no HTML from strings.
 */
import { createHash } from "node:crypto";

import { SCRIPT_PATH } from "../design-system/theme-toggle.ts";
import { formLogic } from "./logic.ts";

/** The header the forms script sends with its posts: the Site answers them in JSON. */
export const FORM_SCRIPT_HEADER = "x-webcraft-form";

const SCRIPT = `(() => {
	const logic = (${formLogic.toString()})();
	const HEADER = ${JSON.stringify(FORM_SCRIPT_HEADER)};
	const LAYOUT = new Set(["section", "step"]);

	const setUp = (form) => {
		let rules;
		try {
			rules = JSON.parse(form.dataset.wcRules || "{}");
		} catch {
			return;
		}
		const fields = rules.fields || [];
		const words = rules.words || {};
		const status = form.querySelector(".wc-form-status");
		const submit = form.querySelector(".wc-form-submit");
		const progress = form.querySelector(".wc-form-progress");
		const steps = [...form.querySelectorAll("fieldset.wc-form-step")];
		const prefix = form.id + "-";
		let current = 0;
		let sending = false;

		const controls = (key) => [...form.querySelectorAll("[name]")].filter((control) => control.name === key);
		const valuesOf = (key) => {
			const values = [];
			for (const control of controls(key)) {
				if (control.disabled) continue;
				if (control.type === "file") for (const file of control.files || []) values.push(file.name);
				else if (control.type === "checkbox" || control.type === "radio") {
					if (control.checked) values.push(control.value);
				} else values.push(control.value);
			}
			return values;
		};
		const filesOf = (key) => {
			const files = [];
			for (const control of controls(key)) {
				if (!control.disabled && control.type === "file") for (const file of control.files || []) files.push(file);
			}
			return files;
		};
		const itemOf = (key) => form.querySelector('[data-wc-key="' + key + '"]');

		// What the conditions show: hidden items are disabled, so they are neither checked nor sent.
		let visible = new Set(fields.map((field) => field.key));
		const applyConditions = () => {
			for (const field of fields) {
				if (!field.condition) continue;
				const item = itemOf(field.key);
				if (!item) continue;
				for (const control of item.querySelectorAll("input, select, textarea")) control.disabled = false;
			}
			visible = logic.visibleKeys(fields, valuesOf);
			for (const field of fields) {
				if (!field.condition) continue;
				const item = itemOf(field.key);
				if (!item) continue;
				const shows = visible.has(field.key);
				if (field.type !== "step") item.hidden = !shows;
				if (!shows) for (const control of item.querySelectorAll("input, select, textarea")) control.disabled = true;
			}
			if (steps.length > 0) showStep(current, false);
		};

		const shownSteps = () => steps.filter((step) => visible.has(step.dataset.wcKey));
		const showStep = (index, focus) => {
			const shown = shownSteps();
			const step = steps[index];
			if (!step || !shown.includes(step)) {
				const next = shown.find((candidate) => steps.indexOf(candidate) > index) || shown[shown.length - 1];
				index = next ? steps.indexOf(next) : 0;
			}
			current = index;
			const position = shown.indexOf(steps[index]);
			steps.forEach((each, n) => {
				each.hidden = n !== index;
			});
			if (progress) {
				progress.hidden = false;
				for (const item of progress.querySelectorAll("li")) {
					const step = steps[Number(item.dataset.wcStep) - 1];
					item.hidden = !shown.includes(step);
					if (step === steps[index]) item.setAttribute("aria-current", "step");
					else item.removeAttribute("aria-current");
				}
			}
			for (const nav of steps[index].querySelectorAll(":scope > .wc-form-step-nav")) {
				nav.hidden = false;
				const back = nav.querySelector(".wc-form-back");
				const next = nav.querySelector(".wc-form-next");
				if (back) back.hidden = position <= 0;
				if (next) next.hidden = position >= shown.length - 1;
			}
			if (submit) submit.hidden = position < shown.length - 1;
			if (focus) {
				const legend = steps[index].querySelector("legend");
				if (status) status.textContent = logic.fill(words.step || "", { n: position + 1, count: shown.length });
				steps[index].setAttribute("tabindex", "-1");
				steps[index].focus();
				if (legend) legend.scrollIntoView({ block: "nearest" });
			}
		};

		const errorId = (key) => prefix + key + "-error";
		const targetOf = (key) => controls(key)[0];
		const clearError = (key) => {
			const error = document.getElementById(errorId(key));
			if (error) error.remove();
			for (const control of controls(key)) {
				control.removeAttribute("aria-invalid");
				const ids = (control.getAttribute("aria-describedby") || "").split(" ").filter((id) => id && id !== errorId(key));
				if (ids.length > 0) control.setAttribute("aria-describedby", ids.join(" "));
				else control.removeAttribute("aria-describedby");
			}
		};
		const showError = (key, message) => {
			clearError(key);
			const target = targetOf(key);
			if (!target) return;
			const error = document.createElement("p");
			error.className = "wc-form-error";
			error.id = errorId(key);
			const lead = document.createElement("span");
			lead.className = "wc-visually-hidden";
			lead.textContent = words.errorPrefix || "";
			error.append(lead, " " + message);
			const wrapper = target.closest(".wc-form-field");
			const group = wrapper && wrapper.querySelector(".wc-form-options");
			if (group) group.before(error);
			else if (wrapper && wrapper.dataset.type === "consent") wrapper.prepend(error);
			else target.before(error);
			target.setAttribute("aria-invalid", "true");
			const ids = (target.getAttribute("aria-describedby") || "").split(" ").filter(Boolean);
			ids.push(error.id);
			target.setAttribute("aria-describedby", ids.join(" "));
		};

		const messageOf = (field, broken) =>
			field.message || logic.fill((words.errors || {})[broken.rule] || "", broken.params || {});
		/** Checks the fields that show inside \`scope\` (a step, a field, the Form): their errors, in order. */
		const check = (scope) => {
			const found = [];
			for (const field of fields) {
				if (LAYOUT.has(field.type) || !visible.has(field.key)) continue;
				const target = targetOf(field.key);
				if (!target || !scope.contains(target)) continue;
				let broken;
				if (field.type === "file") {
					broken = logic.checkFiles(
						field,
						filesOf(field.key).map((file) => ({ name: file.name, size: file.size })),
						field.extensions || [],
					);
				} else {
					broken = logic.readValue(field, valuesOf(field.key), rules.limits, (pattern, text) => {
						try {
							return new RegExp("^(?:" + pattern + ")$", "u").test(text);
						} catch {
							return true;
						}
					}).broken;
				}
				if (broken) found.push({ key: field.key, message: messageOf(field, broken) });
				else clearError(field.key);
			}
			for (const error of found) showError(error.key, error.message);
			return found;
		};

		const announce = (errors) => {
			if (!status) return;
			status.textContent =
				errors.length === 1 ? words.problem || "" : logic.fill(words.problems || "", { count: errors.length });
		};
		const stepHolding = (key) => {
			const target = targetOf(key);
			return steps.findIndex((step) => target && step.contains(target));
		};
		const showErrors = (errors) => {
			announce(errors);
			const first = errors[0];
			if (!first) return;
			if (steps.length > 0) {
				const step = stepHolding(first.key);
				if (step >= 0 && step !== current) showStep(step, false);
			}
			const target = targetOf(first.key);
			if (target) target.focus();
		};

		for (const nav of form.querySelectorAll(".wc-form-step-nav")) {
			nav.addEventListener("click", (event) => {
				const button = event.target.closest("button");
				if (!button) return;
				const shown = shownSteps();
				const position = shown.indexOf(steps[current]);
				if (button.classList.contains("wc-form-next")) {
					const errors = check(steps[current]);
					if (errors.length > 0) return showErrors(errors);
					const next = shown[position + 1];
					if (next) showStep(steps.indexOf(next), true);
				} else if (button.classList.contains("wc-form-back")) {
					const back = shown[position - 1];
					if (back) showStep(steps.indexOf(back), true);
				}
			});
		}

		// A field with an error is checked again as it changes, so its error goes as soon as it is
		// fixed (never on leaving it: the page would move under the pointer). New errors wait for Next
		// or Send.
		const recheck = (event) => {
			const key = event.target && event.target.name;
			if (!key || !document.getElementById(errorId(key))) return;
			const field = fields.find((candidate) => candidate.key === key);
			if (!field) return;
			const target = targetOf(key);
			const wrapper = target && target.closest(".wc-form-field");
			if (wrapper) check(wrapper);
		};
		form.addEventListener("change", (event) => {
			applyConditions();
			recheck(event);
		});
		form.addEventListener("input", (event) => {
			applyConditions();
			recheck(event);
		});

		/** Posts the Form as the browser would, past this script. */
		const fallBack = () => {
			sending = false;
			HTMLFormElement.prototype.submit.call(form);
		};

		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			if (sending) return;
			applyConditions();
			const errors = check(form);
			if (errors.length > 0) return showErrors(errors);
			sending = true;
			if (status) status.textContent = words.sending || "";
			if (submit) submit.setAttribute("aria-disabled", "true");
			const data = new FormData(form);
			const multipart = form.enctype === "multipart/form-data";
			let answer;
			try {
				const response = await fetch(form.action, {
					method: "POST",
					body: multipart ? data : new URLSearchParams(data),
					headers: { [HEADER]: "1" },
					credentials: "same-origin",
				});
				if (response.status !== 200 && response.status !== 422) return fallBack();
				answer = await response.json();
			} catch {
				return fallBack();
			}
			sending = false;
			if (submit) submit.removeAttribute("aria-disabled");
			if (answer && answer.sent) {
				if (answer.location) return location.assign(answer.location);
				const sent = document.createElement("div");
				sent.className = "wc-form-sent";
				sent.id = form.id;
				sent.setAttribute("role", "status");
				sent.setAttribute("tabindex", "-1");
				const text = document.createElement("p");
				text.textContent = answer.message || words.sent || "";
				sent.append(text);
				form.replaceWith(sent);
				sent.focus();
				return;
			}
			const found = Object.entries((answer && answer.errors) || {}).map(([key, message]) => ({ key, message }));
			for (const error of found) showError(error.key, String(error.message));
			if (answer && answer.formError) found.push({ key: "", message: String(answer.formError) });
			if (answer && answer.formError && status) status.textContent = String(answer.formError);
			else showErrors(found);
		});

		applyConditions();
		if (steps.length > 0) {
			// A Form sent back with errors opens on the step of the first one.
			const summary = form.querySelector(".wc-form-errors a[href^='#']");
			const target = summary ? document.getElementById(summary.getAttribute("href").slice(1)) : null;
			const withError = target ? steps.findIndex((step) => step.contains(target)) : -1;
			showStep(withError >= 0 ? withError : 0, false);
		}
	};

	const start = () => {
		for (const form of document.querySelectorAll("form.wc-form[data-wc-rules]")) setUp(form);
	};
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
	else start();
})();
`;

/** The forms script: its file name (`<hash>.js`), address and text. */
export const FORM_SCRIPT = (() => {
	const name = `${createHash("sha256").update(SCRIPT).digest("hex").slice(0, 16)}.js`;
	return { name, href: `${SCRIPT_PATH}${name}`, text: SCRIPT };
})();
