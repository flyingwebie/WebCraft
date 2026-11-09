/**
 * The stylesheet a page in Edit mode loads into the page itself: room for the editing bar, and
 * outlines on the editable regions. Everything else the bar shows is styled inside its own shadow
 * root (`BAR_STYLES`), so the Site's CSS can't reach it.
 */
export const PAGE_STYLES = `
html.wc-edit { scroll-padding-top: 4.5rem; }
`;

/** The editing bar's own stylesheet, loaded inside its shadow root. */
export const BAR_STYLES = `
:host { all: initial; }
`;
