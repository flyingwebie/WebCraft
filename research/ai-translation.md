# Research: Cheap AI models and techniques for AI translation with Protected terms

Researched 2026-11-05. Prices change fast — every number below is dated to its source.

## Summary

- For WebCraft's AI translation, the cheapest frontier-model options (Google Gemini 2.5 Flash-Lite, OpenAI GPT-5 nano, Claude Haiku 5.5) all price well under $0.50/M input tokens and $1/M output tokens as of Nov 2026, making a 30-page × 3-language site cost a few cents to under $1 in raw tokens.
- Dedicated MT (DeepL) prices per character, not per token, bills via a separate API plan, and ships a first-class glossary feature for term consistency — but has weaker JSON/HTML structural awareness than an LLM and a narrower language set than the AI vendors.
- Protected terms are best handled with **placeholder masking** (swap the term for an inert token before sending, restore after) backed by a **glossary-in-prompt** instruction as defense-in-depth; DeepL's own glossary feature does the equivalent server-side for its product only.
- Structured content (HTML/JSON fields) survives translation reliably only when the model is constrained to a **schema** (JSON mode / structured outputs / function calling) or the HTML is pre-segmented so only text nodes are sent — raw prompt-and-hope translation of markup regularly corrupts tags.
- A per-Workspace AI key fits naturally behind **OpenRouter** (unified multi-provider billing, per-key spend limits, 5% BYOK fee) or **Vercel AI Gateway** (zero markup, per-key/team budgets, native Vercel AI SDK integration) more cleanly than direct per-provider keys, which would require WebCraft to build its own BYOK/limit layer per provider.

## Model / price table (dated 2026-11-05)

All prices are official, per 1M tokens, USD, standard (non-batch) synchronous API pricing unless noted. Batch APIs typically halve these.

| Provider | Model | Input $/M | Output $/M | Notes | Source (checked 2026-11-05) |
|---|---|---|---|---|---|
| Anthropic | Claude Haiku 5.5 (≤100k-token prompts) | $0.10 | $0.50 | Batch: $0.05 / $0.25. Cache read: $0.01/M | [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| Anthropic | Claude Haiku 4.5 | $1.00 | $5.00 | Previous-gen Haiku; Batch $0.50/$2.50 | [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| OpenAI | gpt-5-nano | $0.05 | $0.40 | Batch: $0.025 / $0.20 | [OpenAI pricing](https://developers.openai.com/api/docs/pricing) |
| OpenAI | gpt-4o-mini | $0.15 | $0.60 | Batch: $0.075 / $0.30 | [OpenAI pricing](https://developers.openai.com/api/docs/pricing) |
| OpenAI | gpt-5-mini | $0.25 | $2.00 | Batch: $0.125 / $1.00 | [OpenAI pricing](https://developers.openai.com/api/docs/pricing) |
| Google | Gemini 2.5 Flash-Lite | $0.05 | $0.20 | Cheapest Google model found; marked "deprecated" path but still listed | [Google AI Studio pricing](https://aistudio.google.com/docs/pricing) |
| Google | Gemini 3.1 Flash-Lite | $0.125 | $0.75 | Current-gen Flash-Lite | [Google AI Studio pricing](https://aistudio.google.com/docs/pricing) |
| Google | Gemini 3.5 Flash-Lite | $0.15 | $1.25 | | [Google AI Studio pricing](https://aistudio.google.com/docs/pricing) |
| Mistral | Mistral Small 3.2 (25.06) | $0.10 | $0.30 | Official model-card price; third-party aggregators disagree (some show $0.20/$0.60 for other Small versions) — verify at docs.mistral.ai/platform/pricing before committing | [Mistral model card](https://docs.mistral.ai/models/mistral-small-3-2-25-06) |
| Mistral | Mistral Saba | ~$0.20 | ~$0.60 | Not confirmed on an official Mistral page in this pass; consistent across third-party aggregators (OpenRouter-sourced) | third-party aggregators, unverified against mistral.ai |
| DeepSeek | deepseek-flash | $0.003–$0.15 (cache hit/miss) × off-peak/peak | $0.60–$1.20 | Current naming as of Nov 2026 (supersedes "V3" naming); off-peak discount via UTC time-of-day | [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing) |
| DeepSeek | deepseek-v4-pro | $0.022–$0.66 (cache hit/miss) × off-peak/peak | $1.98–$3.96 | Larger/pricier tier | [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing) |
| Qwen (Alibaba) | various Qwen3 sizes | $0.18–$0.60 | $0.18–$5.00 | Highly size-dependent; smallest Qwen3 variants are competitive with DeepSeek-flash, largest (Qwen3 Max) is not cheap. Not fetched from Alibaba Cloud Model Studio directly in this pass | third-party aggregator (anotherwrapper.com), unverified |
| DeepL | DeepL API | — | — | Priced per character, not per token; official API Pro per-character rate not confirmed in this pass (page only showed Translator-product consumer plans: Individual €7.49/mo, Team €24.99/user/mo). Third-party sources estimate ~€20–25 per million characters pay-as-you-go. **Verify at developers.deepl.com/docs before costing** | [DeepL Pro page](https://www.deepl.com/en/pro) (API rate unconfirmed); third-party estimate only |

Caveats:
- Every "unconfirmed" row above should be re-verified against the provider's own pricing page before being used in a cost model that ships to users — aggregator sites disagree with each other and with official pages surprisingly often, and several carry unresolved future dates.
- None of the above include per-request overhead (system prompt, few-shot glossary examples) which for short page-content jobs can dominate token count — see cost estimate below.

## Techniques

### Keeping Protected terms untranslated

Three approaches, usable individually or layered:

1. **Placeholder masking (recommended primary mechanism).** Before sending text to the model, replace each occurrence of a Protected term with an inert, non-translatable token (e.g. `⟦PT_1⟧`), then restore the original term after translation. This is model-agnostic, works with any provider, and is immune to the model "being clever" and translating the term anyway, because the model never sees the term's semantic content. Tradeoff: requires reliable tokenization/boundary matching against the Site's content (case sensitivity, pluralization, mid-word matches) and a restore step that assumes the model preserves placeholder tokens verbatim in the output — which should be checked, since some models normalize or re-order punctuation around unfamiliar tokens.
2. **Glossary-in-prompt.** Pass the Workspace's Protected-term list as a system/user-message instruction ("Do not translate the following terms; keep them exactly as written: ..."). Simple to implement with any provider or gateway, but relies on model instruction-following, so it is a softer guarantee than masking — best used as defense-in-depth alongside masking, not instead of it, or as the sole mechanism for secondary goals like stylistic/tone consistency that masking cannot express.
3. **Provider-native glossaries (e.g. DeepL glossary).** DeepL's glossary API maps source terms to fixed target terms per language pair and applies them server-side during translation; entries are uploaded as TSV/CSV, up to 10 MiB per glossary, up to 1000 glossaries per account ([DeepL glossary docs](https://developers.deepl.com/docs/api-reference/glossaries), checked 2026-11-05). This guarantees consistent term handling for DeepL specifically, but ties WebCraft to DeepL's product and language set, and the docs do not explicitly describe mapping a term to itself to leave it untranslated (implied but unconfirmed) — Protected terms meant to stay verbatim would need an entry mapping the term to itself per target language.

### Translating structured content (HTML/rich text, JSON fields) without breaking markup

- **Don't send raw HTML to a free-text completion and hope.** Models frequently re-order, drop, or mangle tags, especially with nested or self-closing elements.
- **Preferred: segment first, translate text nodes only.** Parse the HTML/rich-text tree, extract only the translatable text runs (leaving tags, attributes, and non-translatable attributes like `href`/`src` untouched), send those as an array of strings, and splice translated strings back into the same tree positions. This bounds the model's job to plain text, which is also where placeholder masking is simplest to apply.
- **Where segmentation isn't practical (free-form rich-text blocks, JSON fields with mixed content): use schema-constrained structured output.** Both OpenAI (Structured Outputs / JSON mode with a JSON Schema) and Anthropic (tool-use / forced JSON via a tool schema) support constraining a response to a declared JSON shape, which can mirror the input field structure (e.g. `{"heading": str, "body_html": str}`) so the model returns well-formed, parseable output rather than free text that might include markdown fences or commentary. This doesn't by itself protect inline HTML tags inside a string value — segmentation (above) remains the stronger guarantee for markup fidelity; schema-constrained output solves the "give me back exactly this shape of JSON, nothing else" problem, which matters for translating whole structured documents/blocks in one call.
- **DeepL's "tag handling"** (XML/HTML tag-handling mode) is a third option specific to that product: it tells DeepL to recognize and skip tags and lets you mark specific tags/attributes as non-translatable (per the Pro API feature list referenced from DeepL's docs) — useful if DeepL is the chosen MT engine, not applicable to a generic LLM call.

### Consistency across a Site

- **Translation memory / caching unchanged strings.** Keep a per-Site, per-language-pair store of (source-string-hash → translated string). Before calling the AI, hash each string to translate and look it up; only call the model for new or changed strings. This is the single biggest cost lever for a CMS: most edits touch a handful of strings, not a whole page, so incremental re-translation after a single field edit should cost near-zero tokens.
- **Model-side caching (prompt caching) is a different, complementary lever.** Anthropic and others charge roughly 10% of input price for cached-prefix reads ([Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), checked 2026-11-05). This helps when the same glossary/system-prompt prefix is reused across many calls in a batch job (e.g. translating 30 pages in one session), but does not replace a translation-memory store, since prompt caches expire in minutes and don't persist across a user's later single-field edit.
- **Glossary application must be consistent regardless of which string a term appears in** — i.e., the placeholder-masking/glossary-in-prompt mechanism above should run uniformly across every string sent to the model, not just "page bodies," so a Protected term in a button label or meta description is treated the same as one in a paragraph.

### Batching and cost estimate for a 30-page site into 3 languages

Rough order-of-magnitude estimate, not a quote:

- Assume ~800 words of translatable content per page → roughly 1,000–1,200 source tokens per page (English averages ~1.3 tokens/word across these tokenizers).
- 30 pages × 3 target languages = 90 page-translation jobs.
- Per job: ~1,200 input tokens (content) + glossary/system-prompt overhead (assume 300–800 tokens, smaller if cached/reused) ≈ 1,500–2,000 input tokens; output tokens are typically similar to input, sometimes 10–30% larger for languages that expand (e.g. German, Finnish) ≈ 1,500–2,500 output tokens.
- Totals: ~135,000–180,000 input tokens and ~135,000–225,000 output tokens for the whole site/all languages.
- At Gemini 2.5 Flash-Lite rates ($0.05/$0.20 per M): roughly **$0.03–$0.05 total**.
- At GPT-5 nano rates ($0.05/$0.40 per M): roughly **$0.06–$0.10 total**.
- At Claude Haiku 5.5 rates ($0.10/$0.50 per M): roughly **$0.08–$0.11 total**.
- Batching (OpenAI/Anthropic Batch APIs, ~50% discount, non-real-time) and translation-memory caching (skipping unchanged strings on re-translation) each cut this further; the real-world dominant cost driver for a CMS is not a one-time full-site translation but the trickle of edits afterward, which translation memory reduces to near-zero marginal tokens.
- At these volumes, DeepL's per-character pricing (order of tens of euros per million characters) is comparable or somewhat higher for a one-off 30-page job, but the real differentiator is DeepL's built-in glossary/tag-handling vs. an LLM's general-purpose flexibility (structured output, reasoning about context, handling arbitrary JSON shapes) — see "Implications" below.

## Providers/gateways for a per-Workspace key

| Option | BYOK support | Per-key spend limits | Markup/fee | Notes |
|---|---|---|---|---|
| **OpenRouter** | Yes — provider credentials managed via `/api/v1/byok` (Management API) | Yes — each provisioned key has a `limit` field and `limit_reset` (e.g. daily); `disabled` flag; usage/limit_remaining reported per key | 5% of normal OpenRouter cost when using your own key, deducted from OpenRouter credits (BYOK usage can be excluded from budget totals via `include_byok_in_limit`) | Single unified API surface across many providers/models; good fit if WebCraft wants "any provider, one integration" per Workspace. [OpenRouter BYOK docs](https://openrouter.ai/docs/use-cases/byok), [provisioning keys docs](https://openrouter.ai/docs/features/provisioning-api-keys), checked 2026-11-05 |
| **Vercel AI Gateway** | Yes — BYOK configured in team AI Gateway settings (no code changes) or per-request via `providerOptions.gateway.byok` | Yes — budgets settable per team, project, API key, or team member; gateway rejects new system-credential requests once budget exceeded; BYOK spend metered separately | **Zero markup** on provider token prices, including with BYOK | Pairs naturally with the Vercel AI SDK as the client library (`ai` npm package) for structured output, streaming, tool calls. [Vercel AI Gateway docs](https://vercel.com/docs/ai-gateway), [AI SDK Gateway provider docs](https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway), checked 2026-11-05 |
| **Direct provider keys** (Anthropic/OpenAI/Google/Mistral/DeepSeek/DeepL, one per Workspace) | N/A — it's just the provider's own key | WebCraft would have to build its own per-key spend tracking/limits; most providers offer *account*-level budgets/alerts, not fine-grained sub-key limits out of the box | No gateway fee, but WebCraft bears multi-provider integration and billing-reconciliation cost | Simplest conceptually per Workspace ("paste your OpenAI key"), but WebCraft re-implements what OpenRouter/Vercel already solved (spend caps, usage reporting, failover) if it wants those guarantees |
| **Vercel AI SDK as client library (not the Gateway)** | N/A — it's a client library, can call any provider's SDK directly or through AI Gateway | Depends on backing provider/gateway | None itself | Gives WebCraft one consistent code-level interface (generateText/streamText/generateObject) regardless of which provider or gateway sits underneath — relevant since WebCraft wants per-Workspace keys *and* a Superadmin-assigned shared key, which is easier to implement against one SDK surface than against five provider SDKs |

## Implications for WebCraft (options, not decisions)

- **Model choice for "AI translation" default:** Gemini 2.5 Flash-Lite, GPT-5 nano, and Claude Haiku 5.5 are all cheap enough that a 30-page/3-language site costs cents, so price alone won't decide the default — quality-per-language, structured-output support, and whichever gateway WebCraft picks for BYOK will matter more. Worth a small quality bake-off per target language pair before picking a default, since none of the public pricing pages assert translation quality.
- **Protected-term mechanism:** placeholder masking should likely be the enforced mechanism (deterministic, provider-agnostic), with glossary-in-prompt as a belt-and-suspenders layer; DeepL-style server-side glossaries are an option only if DeepL is offered as one of the selectable engines, not a general solution across providers.
- **Structured content handling:** segmenting rich-text/HTML into text-node arrays before calling any model (rather than relying on a model to not break markup) looks like the more robust default than leaning on structured-output schemas alone; schemas are still useful for whole-document/JSON-field translation calls.
- **Consistency/cost control:** a translation-memory cache (hash of source string → cached translation) keyed per Site/language is close to mandatory for a CMS, independent of which model is chosen, because it is what keeps ongoing (post-launch, edit-by-edit) translation cost near zero — this is a WebCraft-side feature to build regardless of provider.
- **Per-Workspace AI key + optional Superadmin shared key:** routing all AI translation calls through a gateway (OpenRouter or Vercel AI Gateway) rather than direct provider SDKs would let WebCraft get BYOK, per-Workspace spend limits, and provider failover "for free" instead of building that layer itself; Vercel AI Gateway's zero-markup-on-BYOK plus native AI SDK fit is attractive if WebCraft's stack already uses the Vercel AI SDK, while OpenRouter's flat 5% BYOK fee plus very broad model catalog (including DeepSeek/Qwen/Mistral under one roof) is attractive if provider breadth matters more than marginal fee. A third option — direct per-provider keys with no gateway — avoids any fee but means WebCraft re-implements spend limits and multi-provider plumbing itself.
- **DeepL as an optional "better quality MT" tier:** could be offered as a premium/alternative engine per Workspace (its own glossary and tag-handling are genuine strengths for structured, repetitive website content), priced and billed separately from the token-based providers above, rather than folded into the same per-token cost model.

## Sources

- [Anthropic Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing) — checked 2026-11-05
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) — checked 2026-11-05
- [Google Gemini API pricing (AI Studio docs)](https://aistudio.google.com/docs/pricing) — checked 2026-11-05 (redirected from ai.google.dev/gemini-api/docs/pricing)
- [Mistral Small 3.2 model card](https://docs.mistral.ai/models/mistral-small-3-2-25-06) — checked 2026-11-05 (official price found here; main mistral.ai/pricing page did not render per-model rates in this pass — re-check docs.mistral.ai/platform/pricing before relying on Mistral numbers)
- [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing) — checked 2026-11-05
- [DeepL Pro / plans page](https://www.deepl.com/en/pro) — checked 2026-11-05 (API per-character rate not shown; only consumer Translator plans rendered)
- [DeepL glossary API reference](https://developers.deepl.com/docs/api-reference/glossaries) — checked 2026-11-05
- [OpenRouter: Bring Your Own Key (BYOK)](https://openrouter.ai/docs/use-cases/byok) — checked 2026-11-05
- [OpenRouter: Provisioning API keys](https://openrouter.ai/docs/features/provisioning-api-keys) — checked 2026-11-05
- [Vercel AI Gateway overview](https://vercel.com/docs/ai-gateway) — checked 2026-11-05
- [Vercel AI SDK — AI Gateway provider](https://ai-sdk.dev/providers/ai-sdk-providers/ai-gateway) — checked 2026-11-05
- Third-party aggregators used only where no official page confirmed a number (flagged inline above): anotherwrapper.com, pricepertoken.com (Mistral Saba, Qwen comparisons) — treat as unverified until cross-checked against mistral.ai and Alibaba Cloud Model Studio directly.

## Gaps / not independently verified this pass

- DeepL's official API Pro per-character rate (the pricing page served only consumer Translator-product plans in this session; third-party estimates of ~€20–25/million characters are unconfirmed).
- Mistral Saba's official per-token price (no official Mistral page reached; only third-party aggregator consensus).
- Qwen/Alibaba Cloud Model Studio official pricing (only third-party aggregator data gathered).
- Whether DeepL's glossary supports "map term to itself" as the documented way to leave a term untranslated (the docs describe the mapping mechanism but not this specific use case explicitly).
