/**
 * The stylesheet a page in Edit mode loads into the page itself: room for the editing bar above the
 * page (focus never ends up under it) and for Code mode's panels below it, outlines on the editable
 * regions, and the device widths.
 * Everything the bar shows is styled inside its own shadow root (`BAR_STYLES`), out of the Site's reach.
 */
export const PAGE_STYLES = `
html.wc-edit-on.wc-arrange-on [data-wc-page-placement]{outline:1px dashed #64748b;outline-offset:2px}
html.wc-edit-on.wc-arrange-on [data-wc-placement-selected]{outline:3px solid #2563eb;outline-offset:3px}
[data-wc-placement-prop][contenteditable="true"]:focus{outline:2px solid #2563eb}

webcraft-edit-bar { display: block !important; }
.wc-editor-messages { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
html.wc-edit { padding-top: 3.5rem; scroll-padding-top: 4.5rem; }
html.wc-edit-on [data-wc-field] {
	outline: 1px dashed rgba(79, 70, 229, 0.6);
	outline-offset: 3px;
	cursor: text;
}
html.wc-edit-on [data-wc-field]:hover { outline: 2px solid #4f46e5; }
html.wc-edit-on [data-wc-field]:focus {
	outline: 2px solid #4338ca;
	outline-offset: 3px;
	box-shadow: 0 0 0 5px rgba(255, 255, 255, 0.9);
}
html.wc-edit-on [data-wc-field][data-wc-invalid] { outline: 2px solid #b91c1c; }
webcraft-code-mode { display: block !important; }
html.wc-code { scroll-padding-bottom: calc(42vh + 1rem); }
html.wc-code body { padding-bottom: calc(42vh + 1rem); margin-inline:16rem 18rem !important; }
html.wc-code.wc-code-drawers body { margin-inline:0 !important; }
html.wc-code.wc-code-collapsed { scroll-padding-bottom: 6rem; }
html.wc-code.wc-code-collapsed body { padding-bottom: 6rem; }
html.wc-code [data-wc-code] { cursor: pointer; }
html [data-wc-hidden-placement]:not([data-wc-hidden-placement] *) { opacity:.7; }
.wc-outside-scripts {
	margin: 2rem auto; max-width: 48rem; padding: 0.75rem 1rem;
	border: 1px dashed #71717a; border-radius: 0.75rem;
	background: #f4f4f5; color: #3f3f46; font: 500 14px/1.4 ui-sans-serif, system-ui, sans-serif;
}
.wc-outside-scripts ul { margin: 0; padding: 0; list-style: none; }
.wc-outside-script { padding: 0.25rem 0; }
.wc-outside-script-name { font-weight: 700; }
.wc-outside-script-note { color: #52525b; }
@media (prefers-color-scheme: dark) {
	.wc-outside-scripts { background: #27272a; color: #e4e4e7; border-color: #a1a1aa; }
	.wc-outside-script-note { color: #d4d4d8; }
}
html.wc-edit-tablet body { max-width: 48rem; margin-inline: auto; }
html.wc-edit-phone body { max-width: 24.375rem; margin-inline: auto; }
html.wc-edit-on [data-wc-type="media"] { cursor: pointer; }
html.wc-edit [data-wc-type="media"]:not(img) {
	display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
	min-width: 8rem; min-height: 5rem; padding: 0.5rem; border-radius: 0.5rem;
	background: rgba(79, 70, 229, 0.08);
}
html.wc-edit [data-wc-type="media"]:not(img)::after {
	content: attr(data-wc-empty-label);
	font: 600 13px/1.3 ui-sans-serif, system-ui, sans-serif; color: #3730a3;
}
html.wc-edit:not(.wc-edit-on) [data-wc-type="media"]:not(img) { display: none; }
html.wc-edit-on [data-wc-drop] { outline: 3px solid #4f46e5; outline-offset: 3px; }
html.wc-edit-on [data-wc-loop-focus]:focus { outline: 2px solid #4338ca; outline-offset: 4px; }
@media (prefers-color-scheme: dark) {
	html.wc-edit [data-wc-type="media"]:not(img) { background: rgba(165, 180, 252, 0.12); }
	html.wc-edit [data-wc-type="media"]:not(img)::after { color: #c7d2fe; }
}
html.wc-edit-on [data-wc-type="body"] { cursor: auto; }
html.wc-edit-on [data-wc-type="body"] [data-wc-block-part] { cursor: text; }
html.wc-edit-on [data-wc-type="body"] [data-wc-block-part]:focus { outline: 2px solid #4338ca; outline-offset: 2px; }
html.wc-edit-on [data-wc-type="body"] [data-wc-placeholder]:empty::before {
	content: attr(data-wc-placeholder); color: #52525b; pointer-events: none;
}
html.wc-edit .wc-edit-block { display: block; }
html.wc-edit-on .wc-edit-block { cursor: default; }
html.wc-edit-on .wc-edit-block:focus { outline: 2px solid #4338ca; outline-offset: 3px; }
html.wc-edit-on [data-wc-block-id][data-wc-invalid] { outline: 2px solid #b91c1c; outline-offset: 2px; }
html.wc-edit-on [data-wc-block-id][data-wc-check] { outline: 1px dashed #b45309; outline-offset: 2px; }
html.wc-edit .wc-edit-empty {
	display: inline-block; padding: 0.5rem 0.75rem; border: 1px dashed #71717a; border-radius: 0.5rem;
	background: #f4f4f5; color: #3f3f46; font: 500 13px/1.3 ui-sans-serif, system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
	html.wc-edit-on [data-wc-type="body"] [data-wc-placeholder]:empty::before { color: #d4d4d8; }
	html.wc-edit .wc-edit-empty { background: #27272a; color: #e4e4e7; border-color: #a1a1aa; }
}
`;

/** The editing bar's own stylesheet, inside its shadow root: a dark bar, light or dark popovers. */
export const BAR_STYLES = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.edit-mode {
	--bar: #18181b;
	--bar-text: #fafafa;
	--bar-muted: #a1a1aa;
	--bar-control: #27272a;
	--bar-control-hover: #3f3f46;
	--focus: #fb923c;
	--surface: #ffffff;
	--text: #18181b;
	--muted: #52525b;
	--border: #e4e4e7;
	--hover: #f4f4f5;
	--accent: #4f46e5;
	--danger: #b91c1c;
	--note: #f4f4f5;
	--problem-bg: #fef2f2;
	--problem-text: #991b1b;
	--problem-border: #fecaca;
	font: 500 14px/1.4 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	color: var(--text);
}
@media (prefers-color-scheme: dark) {
	.edit-mode {
		--surface: #18181b;
		--text: #fafafa;
		--muted: #a1a1aa;
		--border: #3f3f46;
		--hover: #27272a;
		--accent: #a5b4fc;
		--danger: #f87171;
		--note: #27272a;
		--problem-bg: #450a0a;
		--problem-text: #fecaca;
		--problem-border: #7f1d1d;
	}
}
.sr-only {
	position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
	overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
button, a, input { font: inherit; color: inherit; }
button { cursor: pointer; border: 0; background: none; }
button:disabled { cursor: default; opacity: 0.6; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.popup :focus-visible, .hint :focus-visible { outline-color: var(--accent); }
svg { flex: none; }

.bar {
	position: fixed; inset-block-start: 0; inset-inline: 0; z-index: 2147483000;
	height: 3.5rem; padding: 0 0.75rem;
	display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
	background: var(--bar); color: var(--bar-text);
	box-shadow: 0 1px 0 rgba(0, 0, 0, 0.3);
}
.start, .middle, .end { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
.start { flex: 1 1 auto; }
.end { flex: 1 1 auto; justify-content: flex-end; }
.logo {
	display: inline-grid; place-items: center; width: 1.75rem; height: 1.75rem; border-radius: 0.375rem;
	background: var(--bar-text); color: var(--bar); font-weight: 700;
}
.site { color: var(--bar-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 12rem; }
.divider { color: var(--bar-muted); }
.control, .segment, .avatar, .publish {
	display: inline-flex; align-items: center; gap: 0.375rem;
	height: 2.25rem; padding: 0 0.625rem; border-radius: 0.5rem; white-space: nowrap;
}
.control { color: var(--bar-text); }
.control:hover, .segment:hover { background: var(--bar-control); }
.page-title { max-width: 14rem; overflow: hidden; text-overflow: ellipsis; }
.chip {
	padding: 0.125rem 0.625rem; border-radius: 999px; white-space: nowrap;
	background: var(--bar-control); color: #d4d4d8; font-size: 13px;
}
.chip.draft { background: #422006; color: #fdba74; }
.chip.safe { display: inline-flex; align-items: center; gap: 0.25rem; background: #052e16; color: #86efac; }
.chip.safe svg { width: 14px; height: 14px; }
.saved {
	min-width: 0; overflow: hidden; text-overflow: ellipsis;
	color: var(--bar-muted); font-size: 13px; white-space: nowrap;
}
.segments { display: inline-flex; gap: 0.125rem; padding: 0.1875rem; border-radius: 0.625rem; background: #0f0f11; }
.segment { color: var(--bar-muted); height: 2rem; }
.segment[aria-pressed="true"] { background: var(--bar-control-hover); color: var(--bar-text); }
.icon-only { padding: 0 0.5rem; }
.language { display: inline-flex; align-items: center; gap: 0.375rem; color: var(--bar-text); white-space: nowrap; }
.publish { background: var(--bar-text); color: var(--bar); font-weight: 600; }
.publish:hover { background: #e4e4e7; }
.avatar {
	width: 2.25rem; padding: 0; justify-content: center; border-radius: 999px;
	background: #52525b; color: #ffffff; font-size: 12px; font-weight: 700;
}

.popup {
	position: fixed; z-index: 2147483001;
	background: var(--surface); color: var(--text);
	border: 1px solid var(--border); border-radius: 0.75rem;
	box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}
.menu { min-width: 15rem; max-height: 60vh; overflow: auto; padding: 0.375rem; }
.menu [role="menuitem"] {
	display: flex; flex-direction: column; gap: 0.125rem; width: 100%; text-align: start;
	padding: 0.5rem 0.625rem; border-radius: 0.5rem; text-decoration: none;
}
.menu .menu-row { flex-direction: row; align-items: center; gap: 0.5rem; }
.menu [role="menuitem"]:hover, .menu [role="menuitem"]:focus { background: var(--hover); }
.menu [aria-current="page"] .menu-title { font-weight: 700; }
.menu-sub { color: var(--muted); font-size: 12px; }

.dialog { width: min(26rem, calc(100vw - 1.5rem)); padding: 1rem 1.25rem; }
.dialog:focus { outline: none; }
.dialog:focus-visible { outline: 2px solid var(--accent); }
.dialog h2 { margin: 0; font-size: 17px; font-weight: 700; }
.dialog .intro { margin: 0.25rem 0 0.75rem; color: var(--muted); }
.changes { list-style: none; margin: 0 -1.25rem; padding: 0; border-block: 1px solid var(--border); }
.changes li { display: flex; align-items: center; gap: 0.75rem; padding: 0.625rem 1.25rem; }
.changes li > svg { color: var(--muted); }
.change { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; }
.change-label { font-weight: 600; }
.change-sub { color: var(--muted); font-size: 13px; }
.link-button { color: var(--muted); padding: 0.25rem 0.5rem; border-radius: 0.375rem; text-decoration: underline; }
.link-button:hover { color: var(--text); }
.empty { margin: 0.5rem 0; color: var(--muted); }
.error:empty { display: none; }
.error { margin: 0.75rem 0 0; color: var(--danger); }
.actions { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-top: 1rem; }
.danger-button { color: var(--danger); padding: 0.375rem 0; text-decoration: underline; }
.primary, .secondary, .danger {
	display: inline-flex; align-items: center; gap: 0.375rem;
	height: 2.25rem; padding: 0 0.875rem; border-radius: 0.5rem; font-weight: 600;
}
.primary { background: var(--text); color: var(--surface); margin-inline-start: auto; }
.secondary { background: var(--hover); color: var(--text); }
.danger { background: #b91c1c; color: #ffffff; }
.small { height: 2rem; padding: 0 0.75rem; }
.confirm { width: 100%; }
.confirm p { margin: 0 0 0.5rem; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
.draft-note {
	display: flex; align-items: center; gap: 0.5rem; margin: 0 0 0 auto;
	padding: 0.5rem 0.75rem; border-radius: 0.5rem; background: var(--note); color: var(--muted);
}
.review { margin: 0 0 0.75rem; padding: 0.625rem 0.75rem; border: 1px solid var(--border); border-radius: 0.5rem; }
.review.sent-back { border-style: dashed; }
.review p { margin: 0; }
.review-head { display: flex; align-items: center; gap: 0.5rem; font-weight: 600; }
.review blockquote { margin: 0.375rem 0 0; padding-inline-start: 0.625rem; border-inline-start: 2px solid var(--border); white-space: pre-wrap; }
.review .review-help { margin-top: 0.375rem; color: var(--muted); font-size: 13px; }
.review-submit { display: flex; flex-direction: column; gap: 0.375rem; width: 100%; }
.review-submit label { font-weight: 600; font-size: 13px; }
.review-note {
	font: inherit; color: var(--text); background: var(--surface); resize: vertical;
	padding: 0.375rem 0.5rem; border: 1px solid var(--muted); border-radius: 0.5rem;
}
.review-actions { display: flex; justify-content: flex-end; }
.chip.review { background: #1e1b4b; color: #c7d2fe; }
.others { display: flex; gap: 0.5rem; margin: 0.875rem 0 0; color: var(--muted); font-size: 13px; }
.others svg { margin-top: 0.125rem; }
.others a { color: var(--text); font-weight: 600; }

.notice {
	position: fixed; z-index: 2147483000; inset-block-start: 4rem; inset-inline: 0.75rem; margin-inline: auto;
	display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem;
	max-width: 48rem; padding: 0.75rem 0.75rem 0.75rem 1rem;
	background: var(--problem-bg); color: var(--problem-text);
	border: 1px solid var(--problem-border); border-radius: 0.75rem; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}
.notice :focus-visible { outline-color: var(--accent); }
.notice-text { display: flex; align-items: flex-start; gap: 0.5rem; flex: 1 1 18rem; min-width: 0; }
.notice-text svg { margin-top: 0.125rem; }
.notice-text p { margin: 0; overflow-wrap: anywhere; }
.notice-actions { display: flex; align-items: center; gap: 0.5rem; margin-inline-start: auto; }
.notice-actions .primary { margin-inline-start: 0; }
.icon-button {
	display: inline-flex; align-items: center; justify-content: center;
	width: 2rem; height: 2rem; border-radius: 0.5rem; color: inherit;
}
.icon-button:hover { background: rgba(0, 0, 0, 0.08); }

.hint {
	position: fixed; z-index: 2147483000; inset-inline-end: 1rem; inset-block-end: 1rem;
	width: min(24rem, calc(100vw - 2rem)); padding: 1rem 1.25rem;
	background: var(--surface); color: var(--text);
	border: 1px solid var(--border); border-radius: 0.75rem; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}
.hint-title { display: flex; align-items: center; gap: 0.5rem; margin: 0; font-weight: 700; }
.hint-text { margin: 0.5rem 0 0.75rem; color: var(--muted); }
.hint-actions { display: flex; justify-content: flex-end; }

.others { display: flex; align-items: center; gap: 0.25rem; margin: 0; padding: 0; list-style: none; }
.other {
	display: inline-grid; place-items: center; width: 1.75rem; height: 1.75rem; border-radius: 999px;
	color: #ffffff; font-size: 11px; font-weight: 700; box-shadow: 0 0 0 2px var(--bar);
}
.presence-tag {
	position: fixed; z-index: 2147482998; padding: 0.125rem 0.5rem; border-radius: 0.25rem;
	color: #ffffff; font-size: 12px; font-weight: 600; pointer-events: none; white-space: nowrap;
}
.tag {
	position: fixed; z-index: 2147482999; padding: 0.125rem 0.5rem; border-radius: 0.25rem 0.25rem 0 0;
	background: #4f46e5; color: #ffffff; font-size: 12px; font-weight: 600; pointer-events: none;
}
.problem {
	position: fixed; z-index: 2147482999; max-width: 22rem; padding: 0.375rem 0.625rem; border-radius: 0.375rem;
	background: var(--problem-bg); color: var(--problem-text); border: 1px solid var(--problem-border); font-size: 13px;
}
.toolbar-wrap { position: fixed; z-index: 2147483001; }
.toolbar, .link-form {
	display: flex; align-items: center; gap: 0.125rem; padding: 0.25rem;
	background: var(--bar); color: var(--bar-text); border-radius: 0.625rem; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}
.link-form { margin-top: 0.25rem; gap: 0.375rem; }
.tool { display: inline-grid; place-items: center; width: 2.25rem; height: 2.25rem; border-radius: 0.5rem; color: var(--bar-text); }
.tool:hover, .tool[aria-pressed="true"] { background: var(--bar-control-hover); }
.tool-divider { width: 1px; height: 1.25rem; margin: 0 0.25rem; background: var(--bar-control-hover); }
.done { height: 2.25rem; padding: 0 0.75rem; border-radius: 0.5rem; background: var(--bar-text); color: var(--bar); font-weight: 600; }
.link-input {
	width: 16rem; height: 2.25rem; padding: 0 0.5rem; border-radius: 0.375rem;
	border: 1px solid var(--bar-control-hover); background: #0f0f11; color: var(--bar-text);
}
.link-form .secondary { background: var(--bar-control); color: var(--bar-text); }

.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.5rem; }
.panel-title { display: flex; align-items: center; gap: 0.5rem; margin: 0; font-size: 16px; font-weight: 700; }
.field { display: flex; flex-direction: column; gap: 0.25rem; margin: 0.75rem 0 0; min-width: 0; }
.field-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.field-label { display: inline-flex; align-items: center; gap: 0.375rem; font-weight: 600; font-size: 13px; }
.text-input, .rich-input, .small-select {
	font: inherit; color: var(--text); background: var(--surface); width: 100%;
	min-height: 2.25rem; padding: 0.375rem 0.5rem; border: 1px solid var(--muted); border-radius: 0.5rem;
}
textarea.text-input { resize: vertical; }
.rich-input { min-height: 4.5rem; }
.rich-input p { margin: 0 0 0.5rem; }
.small-select { width: auto; min-height: 2rem; padding: 0.125rem 0.375rem; }
[aria-invalid="true"] { border-color: var(--danger); }
.help { margin: 0; color: var(--muted); font-size: 13px; }
.help.info { display: flex; align-items: center; gap: 0.375rem; margin-top: 0.75rem; }
.field-status { min-height: 1.25rem; margin: 0.5rem 0 0; color: var(--muted); font-size: 13px; }
.field-problem { margin: 0; color: var(--danger); font-size: 13px; }
.field-problem:empty { display: none; }
.image-popover { width: min(23rem, calc(100vw - 1.5rem)); max-height: calc(100vh - 5rem); overflow: auto; }
.image-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.image-actions .secondary, .item-form .secondary { margin: 0; }
.focal-frame {
	position: relative; display: inline-block; align-self: flex-start; max-width: 100%;
	border-radius: 0.5rem; overflow: hidden; cursor: crosshair; touch-action: none; line-height: 0;
}
.focal-image { display: block; max-width: 100%; max-height: 11rem; user-select: none; }
.focal-dot {
	position: absolute; width: 1.5rem; height: 1.5rem; transform: translate(-50%, -50%);
	border: 2px solid #ffffff; border-radius: 999px; background: rgba(79, 70, 229, 0.35);
	box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.4); cursor: grab;
}
.focal-dot:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
.focal-value { font-variant-numeric: tabular-nums; }

dialog { color: var(--text); background: var(--surface); }
dialog::backdrop { background: rgba(9, 9, 11, 0.5); }
.picker {
	width: min(48rem, calc(100vw - 2rem)); max-height: min(85vh, 48rem); padding: 1rem 1.25rem;
	border: 1px solid var(--border); border-radius: 0.75rem; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
}
.picker-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; }
.picker-tools .text-input { flex: 1 1 14rem; width: auto; }
.picker-grid {
	display: grid; grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr)); gap: 0.5rem;
	margin: 0.5rem 0 0; padding: 0; list-style: none;
}
.picker-item {
	display: flex; flex-direction: column; gap: 0.25rem; width: 100%; padding: 0.25rem; text-align: start;
	border: 1px solid var(--border); border-radius: 0.5rem;
}
.picker-item:hover { background: var(--hover); }
.picker-item[aria-current="true"] { border: 2px solid var(--accent); }
.picker-item img, .picker-empty {
	display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 0.375rem; background: var(--hover);
}
.picker-name { font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.picker-more { display: flex; justify-content: center; margin-top: 0.75rem; }
.picker[data-wc-drop] { outline: 3px dashed var(--accent); outline-offset: -6px; }

.loop-outline, .presence-box {
	position: fixed; z-index: 2147482997; pointer-events: none; border: 2px solid #4f46e5; border-radius: 0.375rem;
}
.loop-tag {
	position: fixed; z-index: 2147482999; padding: 0.125rem 0.5rem; border-radius: 0.25rem;
	background: #4f46e5; color: #ffffff; font-size: 12px; font-weight: 600; pointer-events: none; white-space: nowrap;
}
.loop-toolbar {
	position: fixed; z-index: 2147483001; display: flex; align-items: center; gap: 0.125rem; padding: 0.25rem;
	background: var(--bar); color: var(--bar-text); border-radius: 0.625rem; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}
.loop-toolbar :focus-visible { outline-color: var(--focus); }
.tool-link {
	display: inline-flex; align-items: center; gap: 0.375rem; height: 2.25rem; padding: 0 0.625rem;
	border-radius: 0.5rem; color: var(--bar-text); font-weight: 600; text-decoration: none; white-space: nowrap;
}
.tool-link:hover { background: var(--bar-control-hover); }
.tool-note { max-width: 18rem; padding: 0 0.5rem; color: #d4d4d8; font-size: 12px; }
.loop-notice {
	position: fixed; z-index: 2147483001; inset-block-end: 1.25rem; inset-inline: 0; margin-inline: auto;
	display: flex; align-items: center; justify-content: space-between; gap: 1rem;
	width: max-content; max-width: calc(100vw - 2rem); padding: 0.5rem 0.5rem 0.5rem 1rem;
	background: var(--bar); color: var(--bar-text); border-radius: 0.75rem; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.3);
}
.loop-notice .secondary { background: var(--bar-control); color: var(--bar-text); }
.loop-add {
	position: fixed; z-index: 2147482999; display: inline-flex; align-items: center; gap: 0.375rem;
	height: 2.25rem; padding: 0 0.75rem; border-radius: 0.5rem;
	background: #4338ca; color: #ffffff; font-weight: 600; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}
.item-form { width: min(24rem, calc(100vw - 1.5rem)); max-height: calc(100vh - 5rem); overflow: auto; }
.item-fields { display: flex; flex-direction: column; }
.field-group { margin: 0.75rem 0 0; padding: 0 0.75rem 0.75rem; border: 1px solid var(--border); border-radius: 0.5rem; }
.field-group legend { padding: 0 0.25rem; }
.switch-field { flex-direction: row; flex-wrap: wrap; align-items: center; justify-content: space-between; }
.switch-field .help { flex-basis: 100%; }
.switch {
	position: relative; flex: none; width: 2.75rem; height: 1.5rem; border-radius: 999px; background: #71717a;
}
.switch::after {
	content: ""; position: absolute; inset-block-start: 0.1875rem; inset-inline-start: 0.1875rem;
	width: 1.125rem; height: 1.125rem; border-radius: 999px; background: #ffffff;
}
.switch[aria-checked="true"] { background: #4338ca; }
.switch[aria-checked="true"]::after { inset-inline-start: 1.4375rem; }
.media-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.media-thumb { width: 4rem; height: 2.75rem; object-fit: cover; border-radius: 0.375rem; }
.media-name { flex: 1 1 8rem; min-width: 0; color: var(--muted); font-size: 13px; }

.details-button[aria-expanded="true"] { background: var(--bar-control); }
.drawer {
	position: fixed; z-index: 2147482999; inset-block: 3.5rem 0; inset-inline-end: 0;
	display: flex; flex-direction: column; width: min(26rem, 100vw); padding: 1rem 1.25rem 0;
	background: var(--surface); color: var(--text); border-inline-start: 1px solid var(--border);
	box-shadow: -8px 0 24px rgba(0, 0, 0, 0.12);
}
.drawer:focus { outline: none; }
.drawer:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.drawer-body { flex: 1 1 auto; overflow: auto; padding-bottom: 1.5rem; }
.drawer-section {
	margin: 1.25rem 0 0; padding-top: 1rem; border-top: 1px solid var(--border);
	color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
}
.intro { margin: 0; }
.address-row { display: flex; align-items: center; gap: 0.25rem; }
.address-prefix {
	flex: 0 1 auto; max-width: 55%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
	color: var(--muted); font-size: 13px;
}
.address-row .text-input { flex: 1 1 6rem; }

.more { display: none; }
.sheet {
	margin: auto 0 0; width: 100%; max-width: 100%; max-height: 90vh; padding: 0.5rem 1rem 1.25rem;
	border: 0; border-radius: 1rem 1rem 0 0; box-shadow: 0 -12px 32px rgba(0, 0, 0, 0.25); overflow: auto;
}
.sheet-handle { width: 2.5rem; height: 0.25rem; margin: 0.25rem auto 0.75rem; border-radius: 999px; background: var(--border); }
.sheet-body { display: flex; flex-direction: column; }
.sheet-body:focus { outline: none; }
.sheet-rows { margin: 0; padding: 0; list-style: none; }
.sheet-row {
	display: flex; align-items: center; gap: 0.75rem; width: 100%; min-height: 3rem; padding: 0.5rem 0.25rem;
	border-bottom: 1px solid var(--border); text-align: start; text-decoration: none;
}
.sheet-row-text { flex: 1 1 auto; font-size: 16px; }
.sheet-row-sub { color: var(--muted); }
.sheet-row[aria-current="page"] .sheet-row-text { font-weight: 700; }
.sheet-changes { margin-top: 1rem; }
.sheet-changes p { margin: 0 0 0.25rem; }
.primary.wide { width: 100%; justify-content: center; height: 3rem; margin-top: 0.75rem; }
.publish-sheet .actions { flex-wrap: wrap; }

.body-toolbar {
	position: fixed; z-index: 2147483001; display: flex; align-items: center; gap: 0.125rem; padding: 0.25rem;
	background: var(--bar); color: var(--bar-text); border-radius: 0.625rem; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}
.body-toolbar :focus-visible { outline-color: var(--focus); }
.body-toolbar .drag { cursor: grab; touch-action: none; }
.body-toolbar [aria-disabled="true"] { opacity: 0.45; cursor: not-allowed; }
.body-notes {
	position: fixed; z-index: 2147483000; margin: 0; padding: 0.375rem 0.625rem; list-style: none; max-width: 22rem;
	background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 0.5rem;
	box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); font-size: 13px;
}
.body-notes li + li { margin-top: 0.25rem; }
.body-drop { position: fixed; z-index: 2147483002; height: 3px; border-radius: 2px; background: #4338ca; pointer-events: none; }
.body-panel { width: min(24rem, calc(100vw - 1.5rem)); max-height: calc(100vh - 5rem); overflow: auto; padding: 0.75rem 1rem 1rem; }
.body-panel .panel-title { font-size: 15px; }
.body-menu { padding: 0; min-width: 0; max-height: none; }
.body-menu [role="menuitem"] { flex-direction: row; }
.danger-item { color: var(--danger); }
.chooser { display: flex; flex-direction: column; gap: 0.5rem; }
.chooser-list { max-height: 18rem; overflow: auto; }
.chooser-group {
	padding: 0.5rem 0.5rem 0.25rem; color: var(--muted); font-size: 12px; font-weight: 700;
	letter-spacing: 0.05em; text-transform: uppercase;
}
.chooser-option { padding: 0.5rem 0.625rem; border-radius: 0.5rem; cursor: default; }
.chooser-option[aria-selected="true"] { background: var(--hover); font-weight: 600; }
.check-field { display: flex; align-items: center; gap: 0.5rem; margin: 0.75rem 0 0; font-weight: 600; font-size: 13px; }
.check-field input { width: 1.125rem; height: 1.125rem; margin: 0; }
.body-form > .secondary.small { margin: 0.75rem 0.5rem 0 0; }
.props-form textarea.text-input { min-height: 5rem; font-family: ui-monospace, monospace; }
.toolbar-wrap.above-keyboard .toolbar { width: calc(100vw - 0.75rem); overflow-x: auto; }
.toolbar-wrap.above-keyboard .done { margin-inline-start: auto; }

/* While the optional parts show, they give way first: the start group's site name and saved note shorten
   before the modes, Undo and Redo, or the end group could run into one another. */
@media (min-width: 1101px) { .middle, .end { flex-shrink: 0; } }
@media (max-width: 1100px) { .optional { display: none; } }
@media (max-width: 640px) {
	.bar { padding: 0 0.5rem; gap: 0.25rem; }
	.middle, .language, .publish, .avatar, .details-button, .others, .site, .divider, .saved, .chip.safe { display: none; }
	.more { display: inline-flex; }
	.page-title { max-width: 9rem; }
	.hint { inset-inline: 0.75rem; width: auto; }
	.dialog { width: calc(100vw - 1rem); }
}
@media (pointer: coarse), (max-width: 640px) {
	.control, .segment, .publish, .primary, .secondary, .danger, .link-button, .danger-button, .done,
	.picker-item, .sheet-row, .menu [role="menuitem"], .switch-field .switch, .loop-add, .tool-link {
		min-height: 44px;
	}
	.tool, .icon-button, .avatar, .more { min-width: 44px; min-height: 44px; }
	.chooser-option, .check-field { min-height: 44px; }
	.check-field input { width: 1.5rem; height: 1.5rem; }
	.switch { min-width: 44px; }
	.text-input, .small-select { min-height: 44px; }
}
@media (prefers-reduced-motion: no-preference) {
	.segment, .control, .tool, .publish { transition: background-color 120ms ease; }
}


`;
