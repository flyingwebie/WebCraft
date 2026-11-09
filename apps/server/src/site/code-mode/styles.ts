/**
 * Code mode's own stylesheet, inside its shadow root, so the Site's CSS never reaches it: dark panels
 * below the page (HTML, CSS and JS, with a breadcrumb above them), the outlines it draws over the
 * selected element, suggestion lists and its prompts. The page itself makes room for the panels with
 * the editing bar's page stylesheet (`PAGE_STYLES`).
 */
export const CODE_STYLES = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
.code-mode, .suggest, .dialog-backdrop, .outline {
	--panel: #121214;
	--panel-raised: #1b1b1f;
	--editor: #0c0c0e;
	--line: #2a2a30;
	--text: #e4e4e7;
	--muted: #a1a1aa;
	--focus: #fb923c;
	--accent: #a5b4fc;
	--marked: #23214d;
	--problem: #3b0d0d;
	--warning-bg: #422006;
	--warning-text: #fde68a;
	--danger: #f87171;
	font: 500 13px/1.4 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	color: var(--text);
	color-scheme: dark;
}
.sr-only {
	position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
	overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
button, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; border: 0; background: none; }
button:disabled, select:disabled { cursor: default; opacity: 0.6; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
svg { flex: none; }

.code-mode {
	position: fixed; inset-inline: 0; inset-block-end: 0; z-index: 2147482990;
	height: 42vh; min-height: 16rem;
	display: flex; flex-direction: column;
	background: var(--panel); border-top: 1px solid var(--line);
	box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.25);
}
.code-mode.collapsed { height: auto; min-height: 0; }
.code-mode.collapsed .panels { display: none; }
.topline {
	display: flex; align-items: center; gap: 0.75rem; min-height: 2.5rem; padding: 0.25rem 0.75rem;
	border-bottom: 1px solid var(--line);
}
.badge {
	flex: none; padding: 0.125rem 0.5rem; border-radius: 999px; border: 1px solid #52525b;
	color: var(--text); font-size: 12px;
}
.crumbs-nav { flex: 1 1 auto; min-width: 0; overflow-x: auto; }
.crumbs { display: flex; align-items: center; gap: 0.125rem; margin: 0; padding: 0; list-style: none; white-space: nowrap; }
.crumbs li { display: flex; align-items: center; }
.crumbs li + li::before { content: "›"; color: var(--muted); padding: 0 0.25rem; }
.crumb { padding: 0.25rem 0.375rem; border-radius: 0.375rem; color: var(--muted); }
.crumb:hover { background: var(--panel-raised); color: var(--text); }
.crumb.code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.crumb[aria-current] { color: var(--text); font-weight: 700; }
.usage {
	display: flex; align-items: center; gap: 0.375rem; flex: none; margin: 0;
	padding: 0.25rem 0.625rem; border-radius: 0.5rem; background: var(--warning-bg); color: var(--warning-text);
}
.icon-button { display: inline-grid; place-items: center; width: 2rem; height: 2rem; border-radius: 0.375rem; color: var(--text); }
.icon-button:hover { background: var(--panel-raised); }

.panels { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-inline-end: 1px solid var(--line); }
.panel:last-child { border-inline-end: 0; }
.panel-head {
	display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap;
	padding: 0.375rem 0.625rem; border-bottom: 1px solid var(--line);
}
.panel-head h2 { display: flex; align-items: center; gap: 0.375rem; margin: 0; min-width: 0; font-size: 13px; font-weight: 700; }
.panel-sub { color: var(--muted); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel-tools { display: flex; align-items: center; gap: 0.375rem; }
.segments { display: inline-flex; gap: 0.125rem; padding: 0.125rem; border-radius: 0.5rem; background: #000000; }
.segment { height: 1.75rem; padding: 0 0.5rem; border-radius: 0.375rem; color: var(--muted); }
.segment[aria-pressed="true"] { background: #3f3f46; color: var(--text); }
.primary, .secondary, .danger {
	display: inline-flex; align-items: center; gap: 0.375rem;
	height: 1.75rem; padding: 0 0.625rem; border-radius: 0.375rem; font-weight: 600;
}
.primary { background: #fafafa; color: #18181b; }
.secondary { background: #3f3f46; color: var(--text); }
.danger { background: #b91c1c; color: #ffffff; }
.small { height: 1.75rem; }
.link-button { color: var(--muted); text-decoration: underline; padding: 0.125rem 0.25rem; }
.link-button:hover { color: var(--text); }
.pickers { display: flex; align-items: center; gap: 0.375rem; flex-wrap: wrap; padding: 0.375rem 0.625rem; border-bottom: 1px solid var(--line); }
.pickers label { color: var(--muted); }
.picker { height: 1.75rem; max-width: 12rem; border-radius: 0.375rem; border: 1px solid #52525b; background: var(--panel-raised); color: var(--text); }
.layout { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; padding: 0.375rem 0.625rem; border-bottom: 1px solid var(--line); }
.layout-set { display: flex; align-items: center; gap: 0.125rem; }
.layout-name { color: var(--muted); margin-inline-end: 0.25rem; }
.tool { display: inline-grid; place-items: center; width: 1.75rem; height: 1.75rem; border-radius: 0.375rem; color: var(--text); }
.tool:hover { background: var(--panel-raised); }
.tool[aria-pressed="true"] { background: #4338ca; color: #ffffff; }
.note { margin: 0; padding: 0.5rem 0.625rem; color: var(--muted); border-bottom: 1px solid var(--line); }

.editor {
	position: relative; display: flex; flex: 1 1 auto; min-height: 4rem;
	background: var(--editor); font: 13px/20px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
.gutter {
	flex: none; width: 3rem; overflow: hidden; padding: 8px 0; text-align: end; color: var(--muted);
	user-select: none; border-inline-end: 1px solid var(--line);
}
.gutter span { display: block; height: 20px; padding-inline-end: 0.625rem; }
.gutter .marked { color: var(--text); background: var(--marked); }
.gutter .has-problem { color: #ffffff; background: var(--problem); }
.surface { position: relative; flex: 1 1 auto; min-width: 0; overflow: hidden; }
.highlight, .source {
	position: absolute; inset: 0; margin: 0; padding: 8px 12px;
	font: inherit; letter-spacing: normal; white-space: pre; tab-size: 2; overflow: hidden;
}
.highlight { color: var(--text); pointer-events: none; }
.highlight code { font: inherit; }
.line { display: block; min-height: 20px; width: max-content; min-width: 100%; }
.line.marked { background: var(--marked); }
.line.has-problem { background: var(--problem); }
.caret-line { position: absolute; inset-inline: 0; background: rgba(255, 255, 255, 0.05); pointer-events: none; }
.source {
	overflow: auto; resize: none; border: 0; border-radius: 0; background: transparent;
	color: transparent; caret-color: #fafafa; -webkit-text-fill-color: transparent;
}
.source::placeholder { color: var(--muted); -webkit-text-fill-color: var(--muted); }
.source::selection { background: rgba(165, 180, 252, 0.35); }
.source:focus { outline: none; }
.source:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
.read-only .source { cursor: default; }
.t-tag { color: #f472b6; }
.t-component { color: #c4b5fd; }
.t-attribute { color: #93c5fd; }
.t-string { color: #86efac; }
.t-binding { color: #fcd34d; }
.t-command { color: #fdba74; }
.t-comment { color: var(--muted); font-style: italic; }
.t-keyword { color: #f472b6; }
.t-property { color: #93c5fd; }
.t-variable { color: #fcd34d; }
.t-number { color: #fdba74; }
.t-selector { color: #c4b5fd; }

.problems { margin: 0; padding: 0.375rem 0.625rem; list-style: none; max-height: 6rem; overflow: auto; border-top: 1px solid var(--line); }
.problems li { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.125rem 0; color: #fecaca; }
.problem-link { text-align: start; color: #fecaca; text-decoration: underline; }

.console { display: flex; flex-direction: column; max-height: 35%; min-height: 5rem; border-top: 1px solid var(--line); }
.console-head { display: flex; align-items: center; justify-content: space-between; padding: 0.25rem 0.625rem; }
.console-head h3 { margin: 0; font-size: 12px; font-weight: 700; color: var(--muted); }
.console-log { flex: 1 1 auto; overflow: auto; padding: 0 0.625rem 0.375rem; font: 12px/18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.console-lines { margin: 0; padding: 0; list-style: none; }
.console-line { padding: 0.125rem 0; border-bottom: 1px solid var(--line); white-space: pre-wrap; overflow-wrap: anywhere; }
.console-line.error { color: #fca5a5; }
.console-line.warn { color: #fde68a; }
.console-empty { margin: 0; padding: 0 0.625rem 0.375rem; color: var(--muted); font-size: 12px; }
.console-log:has(.console-line) + .console-empty { display: none; }

.statusline {
	display: flex; align-items: center; justify-content: space-between; gap: 1rem;
	padding: 0.25rem 0.75rem; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px;
}
.statusline p { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.outline { position: fixed; z-index: 2147482980; pointer-events: none; border-radius: 2px; }
.outline.hover { outline: 1px dashed #818cf8; outline-offset: 2px; }
.outline.selected { outline: 2px solid #6366f1; outline-offset: 2px; }
.outline-label {
	position: absolute; inset-block-end: calc(100% + 2px); inset-inline-start: -2px; white-space: nowrap;
	padding: 0.125rem 0.5rem; border-radius: 0.25rem 0.25rem 0 0; background: #4f46e5; color: #ffffff;
	font-size: 12px; font-weight: 600;
}
.outline-label:empty { display: none; }

.suggest {
	position: fixed; z-index: 2147483002; width: 22rem; overflow: hidden; padding: 0.25rem;
	background: var(--panel-raised); border: 1px solid #3f3f46; border-radius: 0.5rem;
	box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
}
.suggest-group {
	padding: 0.375rem 0.5rem 0.125rem; color: var(--muted); font-size: 11px; font-weight: 700;
	letter-spacing: 0.04em; text-transform: uppercase;
}
.suggest-option {
	display: flex; align-items: center; gap: 0.5rem; padding: 0.3125rem 0.5rem; border-radius: 0.375rem; cursor: pointer;
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.suggest-option[aria-selected="true"] { background: #312e81; color: #ffffff; }
.suggest-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.suggest-detail {
	flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	color: var(--muted); font-family: Inter, ui-sans-serif, system-ui, sans-serif; font-size: 12px;
}
.suggest-option[aria-selected="true"] .suggest-detail { color: #e0e7ff; }
.swatch { width: 0.875rem; height: 0.875rem; border-radius: 0.1875rem; border: 1px solid #52525b; }

.dialog-backdrop {
	position: fixed; inset: 0; z-index: 2147483003; display: grid; place-items: center;
	background: rgba(0, 0, 0, 0.5);
}
.dialog {
	width: min(28rem, calc(100vw - 2rem)); padding: 1rem 1.25rem; border-radius: 0.75rem;
	background: var(--panel-raised); color: var(--text); border: 1px solid #3f3f46;
}
.dialog h2 { margin: 0; font-size: 16px; font-weight: 700; }
.dialog p { margin: 0.5rem 0 1rem; color: var(--muted); }
.dialog-actions { display: flex; justify-content: flex-end; gap: 0.5rem; flex-wrap: wrap; }

@media (max-width: 900px) {
	.panels { grid-template-columns: minmax(0, 1fr); overflow: auto; }
	.panel { min-height: 16rem; border-inline-end: 0; border-bottom: 1px solid var(--line); }
	.statusline .hint { display: none; }
}
`;
