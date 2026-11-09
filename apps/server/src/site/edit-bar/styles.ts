/**
 * The stylesheet a page in Edit mode loads into the page itself: room for the editing bar above the
 * page (focus never ends up under it), outlines on the editable regions, and the device widths.
 * Everything the bar shows is styled inside its own shadow root (`BAR_STYLES`), out of the Site's reach.
 */
export const PAGE_STYLES = `
webcraft-edit-bar { display: block !important; }
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
html.wc-edit-tablet body { max-width: 48rem; margin-inline: auto; }
html.wc-edit-phone body { max-width: 24.375rem; margin-inline: auto; }
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
.saved { color: var(--bar-muted); font-size: 13px; white-space: nowrap; }
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
.others { display: flex; gap: 0.5rem; margin: 0.875rem 0 0; color: var(--muted); font-size: 13px; }
.others svg { margin-top: 0.125rem; }
.others a { color: var(--text); font-weight: 600; }

.hint {
	position: fixed; z-index: 2147483000; inset-inline-end: 1rem; inset-block-end: 1rem;
	width: min(24rem, calc(100vw - 2rem)); padding: 1rem 1.25rem;
	background: var(--surface); color: var(--text);
	border: 1px solid var(--border); border-radius: 0.75rem; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}
.hint-title { display: flex; align-items: center; gap: 0.5rem; margin: 0; font-weight: 700; }
.hint-text { margin: 0.5rem 0 0.75rem; color: var(--muted); }
.hint-actions { display: flex; justify-content: flex-end; }

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

@media (max-width: 1100px) { .optional { display: none; } }
@media (prefers-reduced-motion: no-preference) {
	.segment, .control, .tool, .publish { transition: background-color 120ms ease; }
}
`;
