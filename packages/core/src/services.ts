import type { Auth } from "@webcraft/auth";
import type { Database } from "@webcraft/db";
import type { Block } from "@webcraft/renderer";

import type { Account } from "./account.ts";
import type { AiKeys, AiProviders } from "./ai/index.ts";
import type { ApiTokens } from "./api-tokens.ts";
import type { AuditLog } from "./audit-log.ts";
import type { Backups } from "./backups/service.ts";
import type { Builder } from "./builder/index.ts";
import type { Cdns } from "./cdns/index.ts";
import type { Clock } from "./clock.ts";
import type { CodeMode } from "./code-mode/index.ts";
import type { InstallConfig } from "./config.ts";
import type { Confirmation } from "./confirmations.ts";
import type { ConsentService } from "./consent/index.ts";
import type {
	BodyComponent,
	Component,
	ComponentDeletion,
	ComponentDraftChange,
	ComponentMarkup,
	ComponentUsage,
	DefaultLanguageChange,
	DraftChange,
	Entry,
	EntryDeletion,
	EntryReading,
	FieldInput,
	Globals,
	GlobalsChange,
	LanguageChange,
	LanguageRemoval,
	Loop,
	LoopDraftChange,
	LoopItemsChange,
	NewComponent,
	NewEntry,
	NewLanguage,
	NewLoop,
	NewPostType,
	Pasted,
	PostType,
	PostTypeChange,
	PublishAllDone,
	PublishAllPreview,
	Published,
	PublishItem,
	PublishPreview,
	Review,
	RunOutcome,
	SaveBase,
	SavedComponentMarkup,
	SavedTemplateMarkup,
	ScheduleAllDone,
	ScheduleAllPreview,
	ScheduledPublish,
	Script,
	SiteDraft,
	SiteLanguages,
	SpecialPages,
	Template,
	TemplateListing,
	TemplateMarkup,
} from "./content/index.ts";
import type { ContentApi } from "./content-api/index.ts";
import type { Countries } from "./countries.ts";
import type { Dashboards } from "./dashboards/index.ts";
import type {
	ClassChange,
	DesignSystemChange,
	DesignSystemFile,
	DesignSystemImportPreview,
	DesignSystemPreview,
	DesignSystemView,
	EditableClass,
} from "./design-system/index.ts";
import type { Discovery } from "./discovery/index.ts";
import type { DiskSpace } from "./disk.ts";
import type { Dns } from "./dns.ts";
import type { Domains } from "./domains/index.ts";
import type { EditMode } from "./edit-mode/index.ts";
import type { Email, Mailer } from "./email/index.ts";
import type { ErrorLog } from "./error-log/service.ts";
import type { Filters } from "./filters/index.ts";
import type { Forms } from "./forms/index.ts";
import type { InstallHealth } from "./health/service.ts";
import type { HistoryService } from "./history/index.ts";
import type { OutgoingHttp } from "./http.ts";
import type { Impersonation } from "./impersonation.ts";
import type { Imports } from "./imports/index.ts";
import type { InstallSettings } from "./install-settings.ts";
import type { JobQueue } from "./jobs/define.ts";
import type { Logger } from "./log.ts";
import type { MasterKeyBackup } from "./master-key-backup.ts";
import type { ImageProcessor, InstallStorage, MediaLibrary } from "./media/index.ts";
import type { ModuleHost } from "./modules/host.ts";
import type { OAuth } from "./oauth.ts";
import type { People } from "./people.ts";
import type { PersonActor } from "./permissions/can.ts";
import type { RateLimits } from "./rate-limits.ts";
import type { PdfRenderer, Reports, ShareLinks } from "./reports/index.ts";
import type { SiteSearch } from "./search/service.ts";
import type { InstallSecrets } from "./secrets/store.ts";
import type { SeoService } from "./seo/index.ts";
import type { InstallSetup } from "./setup.ts";
import type { DataSample } from "./site-pages/data-samples.ts";
import type { SitePages } from "./site-pages/index.ts";
import type { SiteScripts } from "./site-scripts/index.ts";
import type { SocialCardRenderer } from "./social-cards/renderer.ts";
import type { Staging } from "./staging/index.ts";
import type {
	Access,
	DataLayer,
	InstallScope,
	Site,
	SiteScope,
	Workspace,
	WorkspaceScope,
} from "./tenancy/data-layer.ts";
import type { InvitesService } from "./tenancy/invites.ts";
import type { MembersService } from "./tenancy/members.ts";
import type { MembershipsService } from "./tenancy/memberships.ts";
import type { StaffService } from "./tenancy/staff.ts";
import type { WorkspaceSummary } from "./tenancy/workspaces.ts";
import type { TlsProbe } from "./tls.ts";
import type { Translations } from "./translation/service.ts";
import type { TwoFactor } from "./two-factor/index.ts";
import type { Updates } from "./updates.ts";
import type { Webhooks } from "./webhooks/index.ts";
import type { Workers } from "./workers.ts";

/**
 * The edges of a running Install: real adapters in the processes, fakes in tests. Everything else
 * in `InstallServices` is built on top of them by `createInstallServices`.
 */
export type InstallPorts = {
	config: InstallConfig;
	database: Database;
	jobs: JobQueue;
	mailer: Mailer;
	http: OutgoingHttp;
	/** DNS, for the guarded fetcher's address checks. */
	dns: Dns;
	/** TLS, for the Domain check's look at each domain's certificate. */
	tls: TlsProbe;
	/** The country of an address, for Site analytics (never kept). */
	countries: Countries;
	/** AI providers, called directly with a Workspace's AI key (ADR 0011). */
	ai: AiProviders;
	clock: Clock;
	log: Logger;
	/**
	 * Image processing: only the worker (and the test harness, which drains its jobs) has the real
	 * one; the web process and server commands get `imagesOnlyInWorker` (ADR 0027).
	 */
	images: ImageProcessor;
	socialCardRenderer: SocialCardRenderer;
	/**
	 * Turning a Report's page into a PDF (headless Chromium): only the worker (and the test harness,
	 * with a fake) has a real one; the web process and server commands get `pdfOnlyInWorker`.
	 */
	pdf: PdfRenderer;
	/** The room on the disk local storage is on, for Install health: the real disk unless given. */
	disk?: DiskSpace;
};

/**
 * Everything a running Install's code works with. The web process, the worker and the test
 * harness each build one with `createInstallServices`: real adapters in the processes, fakes at the
 * edges in tests.
 */
export type InstallServices = InstallPorts & {
	/**
	 * The Install's own secrets (Install SMTP, shared AI keys), encrypted under the Master key;
	 * write-only. A Workspace's or Site's secrets are reached through the data layer instead.
	 */
	secrets: InstallSecrets;
	/** Signing in and out, and sessions. */
	auth: Auth;
	/** A person's own account: their sessions and their password, recorded in the Audit log. */
	account: Account;
	/**
	 * Two-factor authentication: a person's own second factors (recorded in the Audit log and
	 * emailed to them), whether it is required of them, the switches that require it, and resets.
	 */
	twoFactor: TwoFactor;
	/**
	 * Impersonation (ADR 0008): who an admin session acts as, and starting and ending it. Every
	 * action while it goes on is recorded as "<Staff> as <Member>".
	 */
	impersonation: Impersonation;
	/** Rate limits, counted in Postgres so every web process shares them (`RATE_LIMITS`). */
	rateLimits: RateLimits;
	/** People with an account, and their admin preferences. */
	people: People;
	/**
	 * AI keys (a Workspace's own, shared Install keys) and what calls cost: every call to an AI provider
	 * goes through `aiKeys.call`, which picks the key, keeps the monthly caps and records the cost.
	 */
	aiKeys: AiKeys;
	/**
	 * AI translation: Translation modes per Site language, the queue of work the worker runs after each
	 * publish (or Translate now), the Review queue, Outdated translations and Protected terms.
	 */
	translations: Translations;
	/** API tokens: people's credentials for the Management API at `/api/v1`, and their limits. */
	apiTokens: ApiTokens;
	/**
	 * AI clients: WebCraft as the OAuth 2.1 authorization server of its MCP server (`/mcp`), and the
	 * grants people approve for AI clients (Your account › AI clients).
	 */
	oauth: OAuth;
	/**
	 * The key the MCP server signs a question's state with (a confirmation an AI client carries
	 * between two calls; `mcpRequestStateKey`), the same in every web process.
	 */
	mcpRequestStateKey: Uint8Array;
	/** The setup wizard and its token. */
	setup: InstallSetup;
	/** Install settings › General. */
	settings: InstallSettings;
	/** Whether the Superadmin has stored the Master key outside the server. */
	masterKey: MasterKeyBackup;
	/**
	 * The tenant data layer: opens the Install, a Workspace or a Site for an actor after checking
	 * their Permission. Every query on tenant data goes through it (ADR 0007).
	 */
	data: DataLayer;
	/** Who people are to `can()`: their roles and what they reach. */
	actors: { person(personId: string): Promise<PersonActor> };
	workspaces: {
		/** The Workspaces the actor can see. */
		list(access: Access): Promise<WorkspaceSummary[]>;
		/** Creates a Workspace; open the Install with `workspace.create` first. */
		create(scope: InstallScope, input: { name: string }): Promise<Workspace>;
	};
	sites: {
		/** The Sites of the scope's Workspace the actor can see. */
		list(scope: WorkspaceScope): Promise<Site[]>;
		/** Creates a Site; open its Workspace with `site.create` first. */
		create(scope: WorkspaceScope, input: { name: string; slug: string }): Promise<Site>;
		/** Where the Site's Staging address is (`https://<slug>.<sites domain>`), or null without a sites domain. */
		stagingUrl(site: Pick<Site, "slug">): string | null;
	};
	/** Post Types: the kinds of Entry a Site holds, their URL patterns and Fields. Structure: open the Site with `structure.edit` to change them. */
	postTypes: {
		list(scope: SiteScope): Promise<PostType[]>;
		get(scope: SiteScope, postTypeId: string): Promise<PostType>;
		create(scope: SiteScope, input: NewPostType): Promise<PostType>;
		update(scope: SiteScope, postTypeId: string, change: PostTypeChange): Promise<PostType>;
		/** The Data tab of its Entry template: an Entry's Draft as the template reads it, with the bindings. */
		data(scope: SiteScope, postTypeId: string, options?: { language?: string; entryId?: string }): Promise<DataSample>;
	};
	/** Entries, each with a Draft and a published version. Open the Site with `entry.edit` to change them. */
	entries: {
		/** With `bodyFormat: "markdown"`, the Body field's values are Markdown (`body-exchange.ts`). */
		list(scope: SiteScope, postTypeId: string, language?: string, reading?: EntryReading): Promise<Entry[]>;
		get(scope: SiteScope, entryId: string, language?: string, reading?: EntryReading): Promise<Entry>;
		create(scope: SiteScope, input: NewEntry): Promise<Entry>;
		/** The one way an Entry's Draft changes. */
		saveDraft(scope: SiteScope, entryId: string, change: DraftChange): Promise<Entry>;
		/**
		 * Deletes an Entry in two steps: without `confirmation` it answers how many Entries link to it
		 * and a confirmation id; with the id it deletes it and removes those links. Open the Site with
		 * `entry.delete`.
		 */
		delete(scope: SiteScope, entryId: string, confirmation?: string): Promise<EntryDeletion>;
		/** The Components a Post Type's Body field allows that are published, with their Props, for the block editors. */
		bodyComponents(scope: SiteScope, postTypeId: string): Promise<BodyComponent[]>;
		/** What was pasted into a Post Type's body (HTML, Markdown or plain text), as Blocks; nothing is saved. */
		pasteBody(scope: SiteScope, postTypeId: string, pasted: Pasted): Promise<Block[]>;
	};
	/**
	 * The Globals: one set of Fields per Site. Staff set the Fields (`structure.edit`); Members edit the
	 * Draft (`entry.edit`); publishing goes through `publishing.publish` with `{ kind: "globals" }`.
	 */
	globals: {
		get(scope: SiteScope, language?: string): Promise<Globals>;
		setFields(scope: SiteScope, fields: readonly FieldInput[]): Promise<Globals>;
		saveDraft(scope: SiteScope, change: GlobalsChange): Promise<Globals>;
		/** The Globals' Data tab: their Draft values as `site.x` reads them, with the bindings. */
		data(scope: SiteScope, language?: string): Promise<DataSample>;
	};
	/** Templates, stored as element trees with a Draft and a published version. Structure: `structure.edit`. */
	templates: {
		/** Every Template the Site can have, made or not, for the Templates screen. */
		list(scope: SiteScope): Promise<TemplateListing[]>;
		/** A Post Type's Entry template, or null while it has none. */
		entryTemplate(scope: SiteScope, postTypeId: string): Promise<Template | null>;
		saveEntryTemplate(scope: SiteScope, postTypeId: string, tree: unknown): Promise<Template>;
		/** A Post Type's Entry template as Template markup (its Draft and published version), or null while it has none. */
		entryTemplateMarkup(
			scope: SiteScope,
			postTypeId: string,
		): Promise<{ template: Template | null; markup: TemplateMarkup | null; version: string | null }>;
		/**
		 * Saves an Entry template's Draft from Template markup; inline styles become generated Classes.
		 * With `basedOn`, refused when the Draft changed since that version (`DraftChangedError`).
		 */
		saveEntryTemplateMarkup(
			scope: SiteScope,
			postTypeId: string,
			markup: string,
			base?: SaveBase,
		): Promise<SavedTemplateMarkup>;
		/** The Site template, or null while the Site has none (its pages show the built-in one). */
		siteTemplate(scope: SiteScope): Promise<Template | null>;
		saveSiteTemplate(scope: SiteScope, tree: unknown): Promise<Template>;
		/** The Site template as Template markup (its Draft and published version), or null while it has none. */
		siteTemplateMarkup(
			scope: SiteScope,
		): Promise<{ template: Template | null; markup: TemplateMarkup | null; version: string | null }>;
		/** Saves the Site template's Draft from Template markup, as `saveEntryTemplateMarkup` does. */
		saveSiteTemplateMarkup(scope: SiteScope, markup: string, base?: SaveBase): Promise<SavedTemplateMarkup>;
		/** A Post Type's Archive template, or null while it has none. */
		archiveTemplate(scope: SiteScope, postTypeId: string): Promise<Template | null>;
		saveArchiveTemplate(scope: SiteScope, postTypeId: string, tree: unknown): Promise<Template>;
		/** A Post Type's Archive template as Template markup (its Draft and published version), or null while it has none. */
		archiveTemplateMarkup(
			scope: SiteScope,
			postTypeId: string,
		): Promise<{ template: Template | null; markup: TemplateMarkup | null; version: string | null }>;
		/** Saves an Archive template's Draft from Template markup, as `saveEntryTemplateMarkup` does. */
		saveArchiveTemplateMarkup(
			scope: SiteScope,
			postTypeId: string,
			markup: string,
			base?: SaveBase,
		): Promise<SavedTemplateMarkup>;
		/** The Site's Search results template (ADR 0021), or null while it has none (the built-in one shows). */
		searchTemplate(scope: SiteScope): Promise<Template | null>;
		saveSearchTemplate(scope: SiteScope, tree: unknown): Promise<Template>;
		/** The Search results template as Template markup (its Draft and published version), or null while it has none. */
		searchTemplateMarkup(
			scope: SiteScope,
		): Promise<{ template: Template | null; markup: TemplateMarkup | null; version: string | null }>;
		/** Saves the Search results template's Draft from Template markup, as `saveEntryTemplateMarkup` does. */
		saveSearchTemplateMarkup(scope: SiteScope, markup: string, base?: SaveBase): Promise<SavedTemplateMarkup>;
	};
	/** A Site's domains: Primary, Redirect and language domains, their verification and the Domain check. */
	domains: Domains;
	/** CDNs in front of Sites: a Site's CDN setting, and the address ranges CDNs publish. */
	cdns: Cdns;
	/**
	 * A Site's Webhooks: signed calls to outside addresses when something happens on the Site, sent by
	 * the worker with retries and kept in a delivery log. Anyone who sees the Site reads them;
	 * changing them takes `structure.edit`.
	 */
	webhooks: Webhooks;
	/**
	 * Dashboards (#103): a Site's, and Workspace Dashboards adding up its Sites, with their Widgets,
	 * their data and CSV exports, and Dashboard templates. Staff build them (`dashboard.manage`), Staff
	 * and Owners see them (`dashboard.view`), and everyone who works on the Site sees those shown to
	 * everyone.
	 */
	dashboards: Dashboards;
	/**
	 * A Site's languages (Structure): the Default language and the others, their names, directions and
	 * domains. Anyone who sees the Site reads them; changing them takes `structure.edit`.
	 */
	languages: {
		get(scope: SiteScope): Promise<SiteLanguages>;
		add(scope: SiteScope, input: NewLanguage): Promise<SiteLanguages>;
		update(scope: SiteScope, code: string, change: LanguageChange): Promise<SiteLanguages>;
		/**
		 * Makes another language the Default language, in two steps: without `confirmation` it answers
		 * what would change and a confirmation id; with it, it goes ahead.
		 */
		setDefault(scope: SiteScope, code: string, confirmation?: string): Promise<DefaultLanguageChange>;
		/**
		 * Removes a language, in two steps: without `confirmation` it answers how many published pages
		 * it has and a confirmation id; with it, it goes ahead. Its values are kept.
		 */
		remove(scope: SiteScope, code: string, confirmation?: string): Promise<LanguageRemoval>;
		/** Turns the browser-language redirect on the home page on or off. */
		setBrowserRedirect(scope: SiteScope, on: boolean): Promise<SiteLanguages>;
	};
	/**
	 * Components: reusable element trees with Props, placed in Templates and other Components, with a
	 * Draft and a published version (published through `publishing.publish` with `{ kind: "component" }`).
	 * Structure: open the Site with `structure.edit`. A Module's Components are listed where it runs.
	 */
	/** The Site's Forms, as Structure: building them, their keys and names, deleting them. */
	forms: Forms;
	components: {
		list(scope: SiteScope): Promise<(Component & { usage: ComponentUsage })[]>;
		get(scope: SiteScope, componentId: string): Promise<{ component: Component; usage: ComponentUsage }>;
		create(scope: SiteScope, input: NewComponent): Promise<Component>;
		/** Saves its Draft: its Props (the full list) and its element tree, either or both. */
		saveDraft(scope: SiteScope, componentId: string, change: ComponentDraftChange): Promise<Component>;
		/** Its Draft and published version as Template markup, with where it is used. */
		markup(
			scope: SiteScope,
			componentId: string,
		): Promise<{ component: Component; markup: ComponentMarkup; version: string; usage: ComponentUsage }>;
		/**
		 * Saves its Draft from Template markup (and new Props, when given); inline styles become
		 * generated Classes. With `basedOn`, refused when the Draft changed since that version.
		 */
		saveMarkup(
			scope: SiteScope,
			componentId: string,
			input: { markup: string; props?: FieldInput[] },
			base?: SaveBase,
		): Promise<SavedComponentMarkup>;
		/** Renames it: Template markup writes the new name everywhere at once. */
		rename(scope: SiteScope, componentId: string, name: string): Promise<Component>;
		/** Deletes it in two steps (a confirmation id, then the delete); refused while anything places it. */
		delete(scope: SiteScope, componentId: string, confirmation?: string): Promise<ComponentDeletion>;
	};
	/**
	 * Filters: the controls visitors use to narrow, search and sort one query Loop, with a Draft and a
	 * published version (published through `publishing.publish` with `{ kind: "filter" }`). Structure:
	 * open the Site with `structure.edit`.
	 */
	filters: Filters;
	/**
	 * Loops: repeated parts of a Site placed in Templates and Components by name, with a Draft and a
	 * published version (published through `publishing.publish` with `{ kind: "loop" }`). Structure:
	 * open the Site with `structure.edit`; their Loop items are Content (`entry.edit`).
	 */
	loops: {
		list(scope: SiteScope): Promise<Loop[]>;
		/** One Loop, its Loop items in `language` (the Default language unless given). */
		get(scope: SiteScope, loopId: string, language?: string): Promise<Loop>;
		create(scope: SiteScope, input: NewLoop): Promise<Loop>;
		/** Saves its Draft: where its items come from, its query, its Loop items' Fields. */
		saveDraft(scope: SiteScope, loopId: string, change: LoopDraftChange): Promise<Loop>;
		/** Saves its Loop items in its Draft, in one language: the whole list, in order. */
		saveItems(scope: SiteScope, loopId: string, change: LoopItemsChange): Promise<Loop>;
		/** Its Data tab: its first item from the Drafts, as JSON, with the bindings that read it. */
		data(scope: SiteScope, loopId: string, language?: string): Promise<DataSample>;
	};
	/**
	 * The Site script and page scripts (ADR 0016): Structure with a Draft, published through
	 * `publishing.publish` with `{ kind: "script" }`. Open the Site with `structure.edit`.
	 */
	scripts: {
		/** The Site script (`entryId` null) or an Entry's page script; null while there is none. */
		get(scope: SiteScope, entryId: string | null): Promise<Script | null>;
		byId(scope: SiteScope, scriptId: string): Promise<Script>;
		/** Saves its Draft, making it the first time; with `basedOn`, refused when it changed since. */
		saveDraft(scope: SiteScope, entryId: string | null, code: string, base?: SaveBase): Promise<Script>;
	};
	/**
	 * Which Pages answer at `/` (the home page), for paths with no page (the 404 page) and for Site
	 * search (the search results page). Choosing
	 * them is Structure: open the Site with `structure.edit`; anyone who sees the Site may read them.
	 */
	pages: {
		settings(scope: SiteScope): Promise<SpecialPages>;
		/** Chooses the home page, or none with null; it applies at once. */
		setHomePage(scope: SiteScope, pageId: string | null): Promise<SpecialPages>;
		/**
		 * Chooses the 404 page, or the built-in one with null; with a language, the 404 page of that
		 * language alone (null: the Site's answers there). It applies at once.
		 */
		setNotFoundPage(scope: SiteScope, pageId: string | null, language?: string): Promise<SpecialPages>;
		/**
		 * Chooses the Site's search results page (ADR 0021), or none with null: its content is the
		 * Search results template, and the Search element sends visitors there. It applies at once.
		 */
		setSearchPage(scope: SiteScope, pageId: string | null): Promise<SpecialPages>;
	};
	/**
	 * Each Site's Design system (ADR 0009): tokens, Classes, base styles, custom CSS and dark mode,
	 * with a Draft; publishing goes through `publishing.publish` with `{ kind: "designSystem" }`.
	 * Structure: open the Site with `structure.edit`.
	 */
	designSystem: {
		get(scope: SiteScope): Promise<DesignSystemView>;
		/** Saves a change to the Draft: each section given replaces that section. */
		saveDraft(scope: SiteScope, change: DesignSystemChange): Promise<DesignSystemView>;
		createClass(
			scope: SiteScope,
			input: ClassChange,
		): Promise<{ class: EditableClass; designSystem: DesignSystemView }>;
		/** Renames or restyles a Class; elements and CSS using it follow, since they refer to it by id. */
		updateClass(
			scope: SiteScope,
			classId: string,
			change: Partial<ClassChange>,
		): Promise<{ class: EditableClass; designSystem: DesignSystemView }>;
		/** Deletes a Class; refused while something uses it (`ClassInUseError` says where). */
		deleteClass(scope: SiteScope, classId: string): Promise<DesignSystemView>;
		/** The Draft's or the published Design tokens as a DTCG file. */
		exportTokens(scope: SiteScope, version: "draft" | "published"): Promise<Record<string, unknown>>;
		/** Imports a DTCG file into the Draft: each kind of token it holds replaces the Draft's. */
		importTokens(scope: SiteScope, file: unknown): Promise<DesignSystemView>;
		/**
		 * The Draft with an unsaved change, as the Design system screen shows it: its compiled
		 * stylesheet, ramps, scale sizes, use counts and the contrast Check. Saves nothing.
		 */
		preview(scope: SiteScope, change: DesignSystemChange): Promise<DesignSystemPreview>;
		/** The Draft's or the published Design system as one file (logged `designSystem.export`). */
		exportFile(scope: SiteScope, version: "draft" | "published"): Promise<DesignSystemFile>;
		/**
		 * Imports a Design system file over the Draft, in two steps: without a confirmation it answers
		 * what would change; with it, it replaces the Draft (logged `designSystem.import`).
		 */
		importFile(
			scope: SiteScope,
			file: unknown,
			confirmation?: string,
		): Promise<{ confirmation: Confirmation; preview: DesignSystemImportPreview } | { designSystem: DesignSystemView }>;
	};
	publishing: {
		/**
		 * Publishes one item: copies its Draft over the published version, clears the Site's page cache
		 * and writes the Audit log. Open the Site with `publishPermission(item)`.
		 */
		publish(scope: SiteScope, item: PublishItem): Promise<Published>;
		/**
		 * Every Draft of the Site (ADR 0014), Content then Structure, each with what changed, who changed
		 * it last and whether the person may publish it. Open the Site with `site.view`.
		 */
		drafts(scope: SiteScope): Promise<SiteDraft[]>;
		/** How many of the Site's Drafts the person may publish. Open the Site with `site.view`. */
		count(scope: SiteScope): Promise<number>;
		/**
		 * Publish all, in two calls: the ticked items' preview and a confirmation id, then, with it,
		 * publishing them all or none (see `publishAll` in `content/publish-all.ts`). Open the Site with
		 * `site.view`; each item needs its own Permission.
		 */
		publishAll(
			scope: SiteScope,
			items: readonly PublishItem[],
			confirmation?: string,
		): Promise<PublishAllPreview | PublishAllDone>;
		/**
		 * What publishing one item would do now, publishing nothing: API clients are shown it and
		 * confirm it before they publish (spec › Management API).
		 */
		preview(scope: SiteScope, item: PublishItem): Promise<PublishPreview>;
		/**
		 * The Site's Scheduled publishes waiting for their time, soonest first (open the Site with
		 * `site.view`); with `item`, those it waits in. See `content/scheduled-publishes.ts`.
		 */
		scheduled(scope: SiteScope, filter?: { item?: PublishItem }): Promise<ScheduledPublish[]>;
		/** One Scheduled publish waiting for its time (open the Site with `site.view`). */
		getScheduled(scope: SiteScope, scheduleId: string): Promise<ScheduledPublish>;
		/**
		 * Schedules one item's publish at a time: its Draft as it is now is what goes live then. Open
		 * the Site with `publishPermission(item)`.
		 */
		schedule(scope: SiteScope, item: PublishItem, at: Date): Promise<ScheduledPublish>;
		/** "Publish all at…", in two calls like Publish all. Open the Site with `site.view`. */
		scheduleAll(
			scope: SiteScope,
			items: readonly PublishItem[],
			at: Date,
			confirmation?: string,
		): Promise<ScheduleAllPreview | ScheduleAllDone>;
		/** Schedules an Entry's unpublish (410 Gone, its Draft kept). Open the Site with `entry.publish`. */
		scheduleUnpublish(scope: SiteScope, item: PublishItem, at: Date): Promise<ScheduledPublish>;
		/** Changes a Scheduled publish's time, keeping the versions it froze. Open the Site with `site.view`. */
		reschedule(scope: SiteScope, scheduleId: string, at: Date): Promise<ScheduledPublish>;
		/** Takes the items' current Drafts into a Scheduled publish. Open the Site with `site.view`. */
		updateScheduled(scope: SiteScope, scheduleId: string): Promise<ScheduledPublish>;
		/** Cancels a Scheduled publish. Open the Site with `site.view`. */
		cancelScheduled(scope: SiteScope, scheduleId: string): Promise<void>;
		/** For the worker: runs every Scheduled publish whose time came. */
		runDue(): Promise<RunOutcome[]>;
	};
	/**
	 * Review (see `content/reviews.ts`): Authors submit Drafts; those who may publish them publish
	 * (through `publishing`), schedule (through `publishing.schedule`) or send them back with a comment.
	 */
	reviews: {
		/** Submits items for Review together, with an optional note. Open the Site with `entry.edit`. */
		submit(scope: SiteScope, items: readonly PublishItem[], note: string | null): Promise<Review[]>;
		/** Withdraws a waiting Review its Author submitted. Open the Site with `entry.edit`. */
		withdraw(scope: SiteScope, reviewId: string): Promise<Review>;
		/** Sends a waiting Review back with a comment. Open the Site with `site.view`; it needs what publishing the item needs. */
		sendBack(scope: SiteScope, reviewId: string, comment: string): Promise<Review>;
		/** The Site's waiting Reviews, oldest first; with `item`, that item's. Open the Site with `site.view`. */
		list(scope: SiteScope, filter?: { item?: PublishItem }): Promise<Review[]>;
		/** One of the Site's Reviews, whatever its state. Open the Site with `site.view`. */
		get(scope: SiteScope, reviewId: string): Promise<Review>;
		/** How many waiting Reviews the person may act on. Open the Site with `site.view`. */
		countToAct(scope: SiteScope): Promise<number>;
		/** An item's Reviews, newest first. Open the Site with `site.view`. */
		ofItem(scope: SiteScope, item: PublishItem): Promise<Review[]>;
	};
	/**
	 * Every publishable item's history: Revisions saved by each publish and Checkpoints of its Draft,
	 * compared with the Draft and restored into it (see `history/index.ts`).
	 */
	history: HistoryService;
	/** The Site side: which Site a hostname belongs to, and its published pages. */
	sitePages: SitePages;
	/** Site search's background work: rebuilding search indexes that are behind (ADR 0021). */
	search: SiteSearch;
	/**
	 * The Consent banner (ADR 0020): each Site's setting (Structure, Staff only), its words (Content,
	 * with a Draft) and the Consent records visitors' choices leave.
	 */
	consent: ConsentService;
	/** SEO (the SEO decision): each Site's SEO settings; Entries' SEO fields and Post Types' are in the content store. */
	seo: SeoService;
	/**
	 * The Content API (ADR 0029): each Site's switch, what it hides and its Content keys (Site
	 * settings, Staff only), and the read-only API frontends built elsewhere call on the Site's domains.
	 */
	contentApi: ContentApi;
	/**
	 * Discovery files (spec stories 117, 118, 119): each domain's robots.txt, sitemaps and llms.txt, and
	 * Entries' Markdown copies, built on request from what is published.
	 */
	discovery: Discovery;
	/**
	 * Site script safety (ADRs 0022, 0023): each Site's Content Security Policy and allowed hosts, its
	 * outside scripts and its Libraries. Open the Site with `structure.edit`.
	 */
	siteScripts: SiteScripts;
	/**
	 * Edit mode (ADR 0022): "Edit on site" links, and the Edit mode sessions they start on a Site's
	 * own domain, each checked again with every request.
	 */
	editMode: EditMode;
	/**
	 * The Staging address (ADR 0014): who may open it (people signed in to the admin who see the Site,
	 * through a single-use link; anyone with the Site's staging password) and the password itself.
	 */
	staging: Staging;
	/**
	 * Code mode (ADR 0016): Staff in Edit mode edit the Template markup, CSS and scripts of what they
	 * select on the page, saved to the Drafts. Open its Site with `codeMode.access(session)`.
	 */
	codeMode: CodeMode;
	/**
	 * The visual builder (ADRs 0002, 0017): Templates and Components opened, previewed on a canvas and
	 * read to and from Template markup, saved through the Template and Component saves. Open the Site
	 * with `structure.edit`.
	 */
	builder: Builder;
	/** Memberships: Members' roles in a Workspace and the Sites they reach. */
	memberships: MembershipsService;
	/** Members of a Workspace: inviting them, their role and Sites, removing them, pending invites. */
	members: MembersService;
	/** Staff: inviting them, their Workspaces, pending invites. */
	staff: StaffService;
	/** Invite links (Staff and Member invites): what they offer, and accepting them. */
	invites: InvitesService;
	/**
	 * Reading the Audit log at each level, a person's own activity, its CSV export and its retention.
	 * Writing it is `scope.audit(…)` (`recordAudit`).
	 */
	audit: AuditLog;
	/** The Install SMTP, Install branding, the System email sender, the Email log and email preferences. */
	email: Email;
	/** Where the Install stores files (Install settings › Storage), and the storage holding each one. */
	storage: InstallStorage;
	/** Each Site's Media library: uploads, texts and folders. */
	media: MediaLibrary;
	/** Each Site's Imports: CSV files (and later other sources) brought in as Drafts, run in the background. */
	imports: Imports;
	/**
	 * The Module host: the Modules this Install loads, their approvals and switches, and running
	 * them (their procedures, Site routes, events and jobs) within what they declared.
	 */
	modules: ModuleHost;
	/**
	 * Backups (ADR 0032): Install settings › Backups, the Backup log, taking one (the worker's daily
	 * Backup) and the keep rules. Restoring is `webcraft admin restore`.
	 */
	backups: Backups;
	/** The update check: the newest WebCraft release the release feed lists, checked once a day. */
	updates: Updates;
	/** The workers working the job queue: their check-ins, and whether one runs now. */
	workers: Workers;
	/** The Error log: unexpected failures, grouped by cause, for the Superadmin (`error-log/`). */
	errorLog: ErrorLog;
	/** Install health and its Health alerts (`health/`). */
	health: InstallHealth;
	/**
	 * Reports (#104): a Dashboard sent as a PDF on a schedule, with AI text, its history and review;
	 * the worker's steps of making and sending one.
	 */
	reports: Reports;
	/** Share links (#104): a Dashboard opened by anyone holding a link, on the Share link address. */
	shareLinks: ShareLinks;
};
