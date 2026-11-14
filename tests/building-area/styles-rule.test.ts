// How the Styles place edits a Class (BA-24, `places-assets/05`): one rule, `.name { … }`, printed
// from the Class's three pieces (styles, its own CSS, its styles from each breakpoint up) and read
// back into them as typed; the quick actions add, change and remove the rule's own declarations.
import { describe, expect, test } from "bun:test";

import {
	declarationOf,
	piecesOf,
	type RuleBreakpoint,
	type RulePieces,
	renamedRule,
	ruleOf,
	samePieces,
	withDeclaration,
	withQuery,
} from "../../apps/server/src/ui/building-area/places/styles/rule.ts";

const BREAKPOINTS: RuleBreakpoint[] = [
	{ id: "bp-lg", name: "Wide", width: 1200 },
	{ id: "bp-md", name: "Tablet", width: 768 },
];

const HERO: RulePieces = {
	styles: "font-family: var(--font-display);\nfont-size: var(--text-5);\nline-height: 1.05;",
	css: "&:hover {\n  color: var(--brand-70);\n}",
	breakpoints: { "bp-md": "font-size: var(--text-4);", "bp-lg": "gap: var(--space-2);" },
};

describe("a Class as one rule", () => {
	test("prints its styles, its own CSS and each breakpoint's styles, narrowest first", () => {
		expect(ruleOf("hero__title", HERO, BREAKPOINTS)).toBe(
			[
				".hero__title {",
				"  font-family: var(--font-display);",
				"  font-size: var(--text-5);",
				"  line-height: 1.05;",
				"",
				"  &:hover {",
				"    color: var(--brand-70);",
				"  }",
				"",
				"  @media (width >= 768px) {",
				"    font-size: var(--text-4);",
				"  }",
				"",
				"  @media (width >= 1200px) {",
				"    gap: var(--space-2);",
				"  }",
				"}",
			].join("\n"),
		);
	});

	test("reads back exactly the pieces it printed", () => {
		const read = piecesOf(ruleOf("hero__title", HERO, BREAKPOINTS), "hero__title", BREAKPOINTS);
		expect(read).toEqual({ ok: true, pieces: HERO });
	});

	test("an empty Class is an empty rule with a line for the caret, and reads as nothing", () => {
		const empty = { styles: "", css: "", breakpoints: {} };
		const text = ruleOf("card", empty, BREAKPOINTS);
		expect(text).toBe(".card {\n  \n}");
		expect(piecesOf(text, "card", BREAKPOINTS)).toEqual({ ok: true, pieces: empty });
	});

	test("what is typed goes to its piece: own declarations, breakpoint blocks, the rest as own CSS", () => {
		const typed = [".card {", "  padding: var(--space-3)", "}"].join("\n");
		expect(piecesOf(typed, "card", BREAKPOINTS)).toEqual({
			ok: true,
			pieces: { styles: "padding: var(--space-3);", css: "", breakpoints: {} },
		});
		const mixed = [
			".card {",
			"  @media (min-width: 768px) { gap: 1rem; }",
			"  color: red; /* brand later */",
			"  @media (width >= 900px) {",
			"    gap: 2rem;",
			"  }",
			"  & h2 { margin: 0; }",
			"}",
		].join("\n");
		const read = piecesOf(mixed, "card", BREAKPOINTS);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.pieces.styles).toBe("color: red; /* brand later */");
		expect(read.pieces.breakpoints).toEqual({ "bp-md": "gap: 1rem;" });
		// A query no breakpoint has, and nested rules, stay as written: the Class's own CSS.
		expect(read.pieces.css).toBe("@media (width >= 900px) {\n  gap: 2rem;\n}\n\n& h2 { margin: 0; }");
	});

	test("strings, comments and brackets never end a statement early", () => {
		const typed = [".card {", '  content: "a;b}";', "  background: url(data:image/png;base64,AA==);", "}"].join("\n");
		const read = piecesOf(typed, "card", BREAKPOINTS);
		expect(read).toEqual({
			ok: true,
			pieces: { styles: 'content: "a;b}";\nbackground: url(data:image/png;base64,AA==);', css: "", breakpoints: {} },
		});
	});

	test("a rule that isn't one Class's block is refused with its line", () => {
		expect(piecesOf(".card {\n  color: red;\n", "card", BREAKPOINTS)).toEqual({
			ok: false,
			problem: "unclosed",
			line: 3,
		});
		expect(piecesOf(".card {\n}\n.other {}", "card", BREAKPOINTS)).toMatchObject({ ok: false, problem: "shape" });
		expect(piecesOf(".other {\n}", "card", BREAKPOINTS)).toMatchObject({ ok: false, problem: "name", line: 1 });
		expect(piecesOf("color: red;", "card", BREAKPOINTS)).toMatchObject({ ok: false, problem: "shape" });
	});

	test("pieces compare as text, ignoring the blank lines around them", () => {
		expect(samePieces(HERO, { ...HERO, styles: `\n${HERO.styles}\n` })).toBe(true);
		expect(samePieces(HERO, { ...HERO, breakpoints: { "bp-md": "font-size: var(--text-4);" } })).toBe(false);
	});

	test("a rename changes the selector and keeps the rest as typed", () => {
		expect(renamedRule(".hero {\n  color: red;\n}", "banner")).toBe(".banner {\n  color: red;\n}");
	});
});

describe("the quick actions on the rule's own declarations", () => {
	const RULE = ".card {\n  display: flex;\n  gap: var(--space-2);\n\n  &:hover {\n    font-size: 2rem;\n  }\n}";

	test("find only the rule's own declaration, not one in a nested rule", () => {
		expect(declarationOf(RULE, "gap")?.value).toBe("var(--space-2)");
		expect(declarationOf(RULE, "font-size")).toBeNull();
	});

	test("add a declaration after the last one, with the caret after its value", () => {
		const added = withDeclaration(RULE, "font-size", "var(--text-5)");
		expect(added?.text).toBe(
			".card {\n  display: flex;\n  gap: var(--space-2);\n  font-size: var(--text-5);\n\n  &:hover {\n    font-size: 2rem;\n  }\n}",
		);
		expect(added?.text.slice(0, added.caret).endsWith("font-size: var(--text-5);")).toBe(true);
	});

	test("change a declaration in place, and remove it with its line", () => {
		expect(withDeclaration(RULE, "gap", "var(--space-4)")?.text).toContain("  gap: var(--space-4);\n");
		expect(withDeclaration(RULE, "display", null)?.text).toBe(
			".card {\n  gap: var(--space-2);\n\n  &:hover {\n    font-size: 2rem;\n  }\n}",
		);
	});

	test("fill an empty rule's empty line", () => {
		expect(withDeclaration(".card {\n  \n}", "color", "var(--ink-60)")?.text).toBe(
			".card {\n  color: var(--ink-60);\n}",
		);
	});

	test("a media query block goes at the end, the caret inside it", () => {
		const added = withQuery(".card {\n  color: red;\n}", "(width >= 768px)");
		expect(added?.text).toBe(".card {\n  color: red;\n\n  @media (width >= 768px) {\n    \n  }\n}");
		expect(added?.text.slice(added.caret)).toBe("\n  }\n}");
	});
});
