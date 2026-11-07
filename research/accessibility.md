# Accessibility: WCAG 2.2, ATAG 2.0, and the European Accessibility Act — facts and options

**This is not legal advice.** It is a factual survey for issue #33, to feed the standard-setting decision in issue #42 ("What accessibility standard do the admin and Site output meet, and how is it checked?"). No recommendation is made here on what WebCraft should target.

## 1. WCAG 2.2 AA criteria most relevant to a CMS admin and to generated Site output

Source: [W3C WAI, WCAG 2.2 quick reference](https://www.w3.org/WAI/WCAG22/quickref/), the normative spec at [w3.org/TR/WCAG22](https://www.w3.org/TR/WCAG22/).

WCAG 2.2 added six new success criteria to WCAG 2.1 before 2.1's own criteria were folded in. The criteria that matter most to an authoring tool (the admin: a drag-and-drop visual builder, a block editor, in-place "Edit mode," forms, dialogs) versus to the HTML a Site emits are not the same list, though several criteria apply to both because the admin also renders HTML that end users (editors) interact with.

**New in WCAG 2.2** (all relevant to the admin's own interactions; some also shape output defaults):
- **2.4.11 Focus Not Obscured (Minimum)** — AA. A focused control must not be entirely hidden by author-created content (sticky headers, toolbars, cookie banners). Directly relevant to a builder with floating panels and toolbars, and to any sticky nav/cookie banner the Site template outputs.
- **2.5.7 Dragging Movements** — AA. Any drag-only interaction needs a single-pointer non-dragging alternative. This is squarely aimed at drag-and-drop interfaces — i.e., the visual builder's canvas, layer reordering, and any drag-to-reorder admin UI. It also applies to front-end widgets the Site might output (e.g., a drag slider) built by the builder.
- **2.5.8 Target Size (Minimum)** — AA. Interactive targets need at least 24×24 CSS px (with exceptions: inline, essential, or spaced equivalents). Relevant to admin toolbar icons/handles and to generated output controls (buttons, close icons on popups).
- **3.2.6 Consistent Help** — A. If help mechanisms (contact info, self-help, chat) exist across multiple pages, their relative order must stay consistent. Applies to both the admin's own help affordances and to any help/contact links the builder outputs across a client Site.
- **3.3.7 Redundant Entry** — A. Don't force re-entry of information already supplied in the same process, unless re-entering is essential. Applies to the admin's own multi-step flows (setup wizards, multi-step forms) and to any multi-step form the no-JS form builder outputs.
- **3.3.8 Accessible Authentication (Minimum)** — AA. Cognitive function tests (e.g., remembering a password, solving a puzzle) cannot be the only method for an authentication step, unless an alternative or assistive mechanism exists. Applies to the admin's own login, and to any login/account feature a Site might embed.

**Carried-over WCAG 2.x criteria with outsized relevance here:**
- **1.1.1 Non-text Content** (A) — alt text for images; applies to generated Site output (editors must be able to supply alt text — this is an ATAG Part B concern too) and to admin icons/controls.
- **1.3.1 Info and Relationships** (A) — semantic structure (headings, lists, landmarks) conveyed in code, not just visually. Directly ties to the issue's framing: WebCraft already has non-blocking "Checks" that warn on semantic HTML (issue #23); this criterion is the formal AA-adjacent (actually Level A) target those checks are approximating.
- **1.4.3 Contrast (Minimum)** (AA) — 4.5:1 text contrast; relevant to design tokens and dark mode (issue's context) — token pairs need to satisfy contrast in both light and dark variants.
- **1.4.11 Non-text Contrast** (AA, WCAG 2.1) — 3:1 for UI component boundaries/states; relevant to admin controls and to form/button styling in output.
- **2.1.1 Keyboard** (A) and **2.1.2 No Keyboard Trap** (A) — both the builder's drag/drop and canvas interactions, and any native `<dialog>` popup, must be fully keyboard operable and never trap focus. Native `<dialog>` (issue #27) has built-in focus-trapping semantics when shown modally, which helps but does not by itself guarantee correct focus-return or Esc-to-close behavior — these must still be verified.
- **2.4.3 Focus Order** (A) and **2.4.7 Focus Visible** (AA) — critical for a visual builder with nested panels and for the in-place "Edit mode" overlay on the live Site; also for any generated interactive component.
- **2.4.4 Link Purpose (In Context)** (A) — relevant to Site output (link text quality) more than the admin.
- **3.3.1 Error Identification** / **3.3.2 Labels or Instructions** (A) — forms, both in the admin (settings forms) and in generated output (the no-JS progressive-enhancement form builder must still produce accessible native error messaging, which is harder without JS-driven live validation).
- **4.1.2 Name, Role, Value** (A) — custom widgets (builder panels, popups, custom form controls) must expose correct accessible name/role/state via semantic HTML or ARIA. This is the criterion most often broken by visual/no-code builders that produce div-soup, and the one most directly checkable by automated tooling (see §5).
- **4.1.3 Status Messages** (AA, WCAG 2.1) — admin save/publish confirmations and inline validation messages should be programmatically announced (e.g., `role="status"`/`aria-live`), relevant to the admin's autosave/publish UX.

**Admin vs. output, in short:**
| Area | Admin UI (builder, forms, dialogs) | Generated Site output |
|---|---|---|
| Primarily admin | 2.5.7, 2.5.8, 2.4.11, 3.3.8 (own login), 2.1.1/2.1.2 for canvas | — |
| Primarily output, authored via the tool | 1.1.1 (alt text entry), 1.3.1 (semantic markup choices) | 1.1.1, 1.3.1, 1.4.3, 3.3.1/3.3.2 (forms), 2.4.7/4.1.2 (popups) |
| Both | 3.2.6, 3.3.7, 4.1.2, 2.4.7 | same |

## 2. ATAG 2.0 — Authoring Tool Accessibility Guidelines

Source: [W3C WAI, ATAG overview](https://www.w3.org/WAI/standards-guidelines/atag/), full spec [w3.org/TR/ATAG20](https://www.w3.org/TR/ATAG20/).

ATAG 2.0 is the W3C guideline aimed specifically at tools that produce web content — exactly WebCraft's admin, visual builder, and block editor. It has two parts, organized (like WCAG) into principles, guidelines, and testable success criteria at A/AA/AAA:

- **Part A — Make the authoring tool user interface accessible.** This is "WCAG applied to the tool itself": the admin UI, the builder canvas, dialogs, and the block editor must themselves be perceivable, operable, understandable, and robust for authors with disabilities (including authors who are themselves disabled editors/content creators, not just the eventual site visitors). In WebCraft's case this covers the shadcn-based admin chrome, the drag-and-drop builder, and the in-place "Edit mode" overlay.
- **Part B — Support the production of accessible content.** This is about what the tool helps (or fails to help) authors do to their output: does it prompt for alt text, does it preserve heading structure instead of generating visually-styled-only headings, does it let authors fix accessibility problems it detects, does it not strip accessible markup on save/export, and does it document accessible-authoring practices. WebCraft's non-blocking semantic/SEO "Checks" (issue #23) are a Part B mechanism in spirit — ATAG Part B explicitly has a guideline cluster for "assist authors in checking for and correcting accessibility problems" at varying conformance levels (e.g., the tool can simply flag problems at a lower level, versus proactively repairing them at a higher level).

Mapping for WebCraft's specific features:
- Visual builder (drag-and-drop) → Part A (must be keyboard/screen-reader operable itself) + Part B (must not force authors into inaccessible markup, e.g. div-based "headings").
- Block editor → same split; block templates are a good lever for Part B (accessible defaults baked into blocks).
- In-place "Edit mode" on the live Site → Part A, since it is itself an authoring interface overlaid on rendered output.
- Checks (non-blocking) → Part B's "detect and assist correction" guidelines, at whatever conformance level the warnings currently reach (warning only, vs. guided repair, vs. blocking).

ATAG does not have its own separate legal force in the EU; it is referenced by WCAG/EAA ecosystems as the authoring-tool-specific guidance, and some accessibility procurement standards cite it informatively.

## 3. European Accessibility Act — Directive (EU) 2019/882

Source: [EUR-Lex, Directive (EU) 2019/882](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32019L0882).

**Scope.** Article 2 splits coverage into products (Art. 2(1): consumer general-purpose computer hardware and its OS, certain self-service terminals such as ATMs/ticketing/check-in machines, consumer terminal equipment for electronic communications or audiovisual media, e-readers) and services (Art. 2(2): electronic communications services, audiovisual media access services, parts of air/bus/rail/waterborne passenger transport such as websites/apps/e-ticketing, consumer banking services, e-books and dedicated software, and **e-commerce services**). Emergency communications ("112") are covered separately (Art. 2(3)).

**Application date.** 28 June 2025 is the cutoff written into Art. 2(1)–(2) for products placed on the market and services provided from that date. The Act has therefore been in force for about 16 months as of this research (2026-11-07).

**Who it binds.** Art. 3(21) defines "economic operator" as the manufacturer, authorised representative, importer, distributor, or **service provider**. Microenterprises (fewer than 10 staff, turnover/balance sheet ≤ EUR 2 million, Art. 3(23)) providing services are exempt from the service accessibility requirements (Art. 4(5)); product obligations for microenterprises are described as lighter (Recital 71).

**Does "CMS software" or "a website" fall in scope as such?** Not directly and not simply. The EAA does not name "content management system" or "website" as a covered product in its own right. Websites and apps are covered only through specific service categories:
- E-commerce services are explicitly covered (Art. 2(2)(f), defined Art. 3(30) as services provided at a distance through websites/mobile apps by electronic means), and Recital 43 says e-commerce obligations apply to "the online sale of any product or service," even one otherwise covered elsewhere.
- Transport-service websites/apps/e-ticketing are covered (Art. 2(2)(c)).
- E-book software is covered (Art. 2(2)(e)).

So: a client Site built in WebCraft that *sells something online* is plausibly an "e-commerce service" in scope of the EAA, making its **operator** (the business selling) the "service provider" bound by the Act, not WebCraft (the CMS vendor) or the agency building it, at least not directly as "service providers" under this Directive. The CMS maker's obligations, if any, would arise indirectly — e.g., as a commercial pressure from its agency customers who need an EAA-compliant output, or because the CMS itself, if sold/offered as a hosted software-as-a-service product ("dedicated software" under e-books, or potentially "electronic communications" adjacent categories), could itself be assessed against a products/services category — this is genuinely unclear from the Directive text alone and is exactly the kind of question Annex I (technical requirements) and national guidance address in more detail than the articles reviewed here.

**Who "typically" carries the obligation, with caveats.** In practice, for a self-hosted multi-tenant CMS used by agencies to build client sites:
- The **site owner/operator** (the agency's client) is the most likely "service provider" for EAA purposes, when the site is or includes an in-scope service (e-commerce, transport, banking, etc.).
- The **agency** building the site may carry contractual or professional-standard obligations toward its client, and in some jurisdictions could be treated as acting on the economic operator's behalf, but is not squarely named as an "economic operator" category in the Directive itself.
- The **CMS maker** (WebCraft) is not named as a covered product/service unless it separately falls into a category (e.g., offering the CMS itself as a hosted e-commerce-adjacent or dedicated-software service). Its exposure is more reputational/contractual (agencies choosing CMS platforms partly on accessibility capability) than direct legal liability, on the text reviewed.
- This is **not a clean single answer** — it depends on each site's specific business activity, the Member State's transposition, and roles as "manufacturer" vs. "service provider" vs. mere tool supplier. Confirm with counsel per-jurisdiction before relying on this for a specific client engagement.

**Irish transposition.** Ireland transposed the EAA via **S.I. No. 636 of 2023** — the European Union (Accessibility Requirements of Products and Services) Regulations 2023, signed 12 December 2023, notice published in Iris Oifigiúil 15 December 2023, in force since 28 June 2025. Enforcement functions are reportedly split across the CCPC, ComReg, the Central Bank, and the NTA depending on sector. (Secondary-source summary; verify current text on irishstatutebook.ie before relying on it — the original S.I. text itself was not directly fetched for this research.) See also Ireland's National Disability Authority EAA overview: [nda.ie/eaa](https://nda.ie/eaa).

### Web Accessibility Directive (EU) 2016/2102 — the older, narrower companion

Source: [EUR-Lex, Directive (EU) 2016/2102](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016L2102).

- **Scope:** only the websites and mobile apps of **public sector bodies** (state, regional/local authorities, bodies governed by public law, and certain associations) — not private agencies' client sites in general. Explicit exclusions: public broadcasters, most NGOs, certain file formats, time-based media, maps, third-party/archived content, with Member-State discretion to exclude some school/kindergarten sites (Art. 1).
- **Who it binds:** addressed to Member States (Art. 15), who must ensure their public sector bodies comply — relevant to WebCraft only if an agency's client is a public-sector body (e.g., a municipality or school).
- **Standard referenced:** EN 301 549 (the 2015 version, V1.1.2, named in the text fetched), not WCAG directly, though EN 301 549 itself incorporates WCAG (see §4).
- **Accessibility statement (Art. 7):** each public sector body must publish and keep updated a statement, in an accessible format, based on a Commission model statement, containing: (a) which content is inaccessible and why, with any accessible alternative; (b) a description of and link to a feedback mechanism; (c) a link to the enforcement/complaints procedure. Websites publish the statement on-site; apps publish it on the body's website or with the app's download info.
- **Monitoring:** Member States periodically monitor compliance using a Commission-set methodology and report publicly every three years (first report was due 23 December 2021).

## 4. EN 301 549 — the technical standard EU law references

Source: [ETSI EN 301 549 deliverable listing](https://www.etsi.org/deliver/etsi_en/301500_301599/301549/).

EN 301 549, "Accessibility requirements for ICT products and services," is the harmonised European standard both Directives point to for presumption of conformity. It does not invent its own accessibility criteria for web content — it **incorporates WCAG by reference** (historically WCAG 2.0, then updated to track WCAG 2.1, and expected to continue tracking WCAG 2.2) alongside hardware, non-web software, documents, and relay-service requirements outside WCAG's scope.

**Version found:** the ETSI deliverable directory lists versions up to **V4.1.1** (folder `04.01.01_60`, most recent timestamp **2026-09-02**), with intermediate V4.1.0 drafts dated 2025-11-12 and 2026-06-24. This is newer than the V3.2.1 (2021) version commonly cited in older EAA commentary, meaning **EN 301 549 has had at least one major version update (v3 → v4) since the EAA's 28 June 2025 application date** — a material fact worth flagging for issue #42, since whichever version a "meets EN 301 549" claim is scoped to should be stated explicitly. The Web Accessibility Directive text itself still references the much older V1.1.2 (2015), underscoring that the two Directives can lag different versions of the same referenced standard. Confirm the exact v4 WCAG-version alignment on ETSI's official document page before citing a specific clause number.

## 5. Automated checking tools: what they catch and what they miss

Primary sources consulted: [axe-core API docs (dequelabs/axe-core, develop branch)](https://github.com/dequelabs/axe-core/blob/develop/doc/API.md), [Deque Automated Accessibility Coverage Report](https://www.deque.com/automated-accessibility-coverage-report/).

**What they reliably catch:** colour contrast ratios, missing `alt` attributes, missing form labels, duplicate IDs, invalid/misused ARIA attributes and roles, missing document `lang`, some heading-level skip detection, missing landmark regions, and other structurally-detectable DOM patterns. These map well onto WCAG 4.1.2 (Name, Role, Value), 1.1.1 (presence, not quality, of alt text), 1.4.3 (contrast), and parts of 1.3.1.

**What axe-core's own documentation says about coverage/limits:** the fetched API docs state axe-core "only checks rendered content, to minimize false positives (that includes visually-hidden content)" and explicitly notes "Axe does not test hidden regions, such as inactive menus or modal windows" — directly relevant to a popup/`<dialog>`-heavy admin and Site output, since closed dialogs and off-canvas panels won't be scanned unless opened first. Axe also returns an explicit `incomplete` result category for checks that "were aborted and require further testing" — i.e., axe itself flags some checks as needing a human.

**Coverage figures (from secondary sources, since axe-core's own docs reviewed here did not state a percentage):** Deque's own Automated Accessibility Coverage Report found automated issues for only 16 of the 50 WCAG 2.1 Level AA success criteria (~32%) when counting by criterion, but 57.38% of total real-world issues when counting by issue volume — the oft-cited "30–57%" range comes from this difference in counting methodology, not from a single number axe-core publishes about itself. A W3C WAI mailing-list exchange (Steve Green vs. a Deque representative) shows even practitioners disagree sharply — estimates from "as little as 0%" to "up to 50% or more" depending on the site and how "WCAG issue" is counted. Treat all these percentages as approximate and methodology-dependent, not as a precise, citable axe-core claim.

**What no automated tool can judge**, consistently noted across sources: whether alt text is *meaningful* (vs. merely present), whether reading/focus order is logical, whether a heading is used for its true semantic level vs. just visual styling, keyboard-trap edge cases inside complex widgets, cognitive load / plain-language quality, whether an error message is actually *understandable*, and context-dependent judgments generally (e.g., is this image decorative or informative). These gaps are why WCAG conformance claims conventionally require manual/expert review in addition to automated scanning — automation is a floor, not a ceiling.

**Where these tools can run for WebCraft:** axe-core (and Lighthouse's accessibility audit, built on similar rule logic; WAVE; Pa11y, which commonly wraps axe or HTML_CodeSniffer) can run (a) inside a CI/build pipeline against rendered Site output HTML, (b) live inside the admin against the builder's rendered preview, or (c) as a browser-extension spot-check by a human reviewer. Given axe's "rendered content only" and "no hidden regions" limits, a build-time check would need to open dialogs/popups and simulate interactive states to get useful coverage of the `<dialog>`-based popups already in use (issue #27).

## 6. Accessibility statements

Already detailed in §3 for the Web Accessibility Directive (Art. 7): content requirements (inaccessible content + reason + alternative; feedback mechanism description and link; enforcement-procedure link), publication location (on the site itself, or with app download info), and the duty to respond to feedback in a reasonable time.

**EU model template:** Commission Implementing Decision (EU) 2018/1523 of 11 October 2018 establishes the model accessibility statement under the Web Accessibility Directive — see [EUR-Lex eli/dec_impl/2018/1523](https://eur-lex.europa.eu/eli/dec_impl/2018/1523/oj). Its annex has mandatory content (compliance status, non-accessible content, preparation method, feedback/contact info, enforcement procedure) and optional content, recommends the statement be easy to find (e.g., linked from a persistent header/footer) and, where appropriate, available in a machine-readable format. Several Member States host localized versions of this template (e.g., Luxembourg's, linked from national accessibility portals) built on the same structure, under CC BY 4.0 licensing noted on at least the Luxembourg copy.

**EAA and statements:** the EAA (2019/882) does not impose an identical statement regime by that name for private-sector products/services the way the Web Accessibility Directive does for public bodies; its mechanism is instead a **declaration of conformity** attached to the product/service and self-assessment against Annex I requirements, plus market-surveillance/complaint channels run by national bodies (in Ireland, split across CCPC/ComReg/Central Bank/NTA per the secondary sources found). This is a materially different compliance-documentation mechanism than the Web Accessibility Directive's public-facing accessibility statement, and conflating the two in later work (issue #42) would be a mistake worth flagging explicitly.

## 7. What's changed or is in motion as of 2026-11-07

- **EN 301 549** has moved to **V4.1.1** (dated 2026-09-02 per the ETSI deliverable directory), up from the V3.2.1 (2021) baseline that was current when the EAA took effect — a version bump happened within roughly a year of the EAA's 28 June 2025 application date. The exact WCAG-version alignment of V4.x was not independently confirmed from an ETSI changelog in this pass; confirm before citing specific clause numbers.
- **WCAG 3.0** remains a **W3C Working Draft**, not a Recommendation. The most recent draft found is dated **10 September 2026**, and W3C's own messaging says WCAG 3 is not expected to reach completed-standard (Recommendation) status for "a few more years," with some commentary suggesting 2028 or later. WCAG 2.2 remains the current standard in force, and W3C has indicated WCAG 2.2 and WCAG 3 will coexist for an extended transition once WCAG 3 does reach Recommendation. ([W3C WAI, WCAG 3 Introduction](https://www.w3.org/WAI/WCAG3), [W3C, WCAG 3 Working Draft announcement, March 2026](https://www.w3.org/WAI/news/2026-03-03/wcag3))
- **EAA enforcement experience** is still young (roughly 16 months of application); no material amendment to Directive 2019/882 itself was found in this pass. Nothing suggests the scope questions in §3 (CMS vs. output vs. operator) have been clarified by a subsequent amendment or binding EU-level guidance found in this research pass — this remains an open interpretive area as of today.

---

### Sources
- W3C WAI, WCAG 2.2 Quick Reference: https://www.w3.org/WAI/WCAG22/quickref/
- W3C, WCAG 2.2 Recommendation: https://www.w3.org/TR/WCAG22/
- W3C WAI, ATAG overview: https://www.w3.org/WAI/standards-guidelines/atag/
- W3C, ATAG 2.0 spec: https://www.w3.org/TR/ATAG20/
- EUR-Lex, Directive (EU) 2019/882 (European Accessibility Act): https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32019L0882
- EUR-Lex, Directive (EU) 2016/2102 (Web Accessibility Directive): https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016L2102
- EUR-Lex, Commission Implementing Decision (EU) 2018/1523 (model accessibility statement): https://eur-lex.europa.eu/eli/dec_impl/2018/1523/oj
- ETSI, EN 301 549 deliverable directory: https://www.etsi.org/deliver/etsi_en/301500_301599/301549/
- dequelabs/axe-core API documentation: https://github.com/dequelabs/axe-core/blob/develop/doc/API.md
- Deque, Automated Accessibility Coverage Report: https://www.deque.com/automated-accessibility-coverage-report/
- W3C WAI, WCAG 3 Introduction: https://www.w3.org/WAI/WCAG3
- W3C, WCAG 3 Working Draft news, March 2026: https://www.w3.org/WAI/news/2026-03-03/wcag3
- Ireland, National Disability Authority, EAA overview: https://nda.ie/eaa
- Secondary (verify against irishstatutebook.ie before relying on it): summaries of S.I. No. 636 of 2023 (Irish EAA transposition)

## Options at a glance

| Option | What it covers | Who it binds | Effort to adopt | Gaps |
|---|---|---|---|---|
| Target WCAG 2.2 AA for Site output only | The HTML the builder emits for client Sites | Advisory for WebCraft; compliance burden sits mainly with site owner/operator | Medium — requires builder/block defaults and Checks to enforce most AA criteria | Doesn't address admin UI accessibility (ATAG Part A); automated checks alone won't verify it |
| Target WCAG 2.2 AA for admin UI (ATAG Part A) + Site output (ATAG Part B) | Both the authoring tool and its output | Primarily WebCraft as CMS maker, informing what agencies/owners inherit | High — shadcn admin, drag-and-drop builder, block editor, in-place Edit mode all need audit | ATAG is advisory, not legally mandated by itself; still needs manual review beyond ATAG checklists |
| Rely on current non-blocking Checks (issue #23) as the only mechanism | Whatever semantic/SEO issues Checks already flag | N/A — status quo | Low — already built | Checks are non-blocking and don't cover most WCAG AA criteria (contrast, keyboard, focus, dragging, target size, ARIA correctness) |
| Add automated scanning (axe-core or similar) in build pipeline and/or admin | Contrast, missing alt/labels, ARIA misuse, heading structure, landmarks | N/A — tooling choice | Medium — needs rendered-state coverage for dialogs/popups and dynamic builder states | Covers roughly a third to a half of issues at best by most estimates; cannot judge alt text quality, reading order, heading semantics correctness, keyboard traps, or cognitive load — needs manual review layered on top |
| Publish an accessibility statement (EU model-based) per Site | Transparency/compliance documentation under the Web Accessibility Directive (mandatory only for public-sector sites) | Site owner/operator (public sector); voluntary good practice otherwise | Low–Medium — could be a CMS feature (template + fields) rather than manual per-site authoring | Only legally mandated for public-sector bodies under 2016/2102; EAA uses a different conformity-declaration mechanism, not this statement |
| No formal standard target; handle accessibility ad hoc per project | Whatever each agency/developer chooses | Agency/site owner entirely | None | No consistent baseline, no defensible compliance position, highest legal/reputational exposure for clients in EAA-covered categories (e.g., e-commerce) |

## Questions for the grilling (issue #42)

- Does WebCraft target WCAG 2.2 AA for generated Site output, for the admin UI, or both — and if both, are they the same conformance level or different ones?
- Does WebCraft adopt ATAG 2.0 formally (which conformance level, A/AA/AAA, and which parts), or just use it informally as a design reference for the builder and block editor?
- Which automated tool (axe-core, Lighthouse, Pa11y, WAVE, or more than one) runs where — in CI against built Site output, live inside the admin, both, neither — and what is the pass/fail/warn policy (blocking vs. the existing non-blocking Checks model from issue #23)?
- Given axe-core-class tools reliably cover only a fraction of WCAG criteria (estimates range roughly 20–57% depending on counting method) and cannot verify alt-text quality, reading order, heading semantics, keyboard traps, or cognitive load, what manual-review process (if any) supplements automated checks, and who performs it — WebCraft, the agency, or the site owner?
- Should WebCraft treat the drag-and-drop builder's dragging interactions as requiring a built-in non-drag alternative by default (WCAG 2.5.7), given this is a known common failure point for visual builders?
- Does WebCraft take a position on who "owns" EAA/Web Accessibility Directive compliance for a given client Site — agency, site owner, or shared — and does that affect what the product should default to, warn about, or document (e.g., contractual language, onboarding prompts)?
- Should WebCraft ship an accessibility-statement feature (fields/template) for Sites, especially ones likely to be public-sector or e-commerce, even though it's not universally legally required?
- Which version of EN 301 549 (and which underlying WCAG version) should any compliance claim reference, given the standard has moved versions (V3.2.1 → V4.1.x) since the EAA's 28 June 2025 application date?
- Should WebCraft wait on WCAG 3 given it's still a Working Draft with no near-term Recommendation expected, or treat WCAG 2.2 as the stable target indefinitely?
- Does the "AA" bar apply uniformly, or does WebCraft want to score/flag specific high-value criteria (e.g., 4.1.2, 1.3.1, 2.4.7, 2.5.7) more strictly than others, mirroring how Checks already triage semantic/SEO issues by severity?
