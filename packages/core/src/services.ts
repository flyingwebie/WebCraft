import type { Auth } from "@webcraft/auth";
import type { Database } from "@webcraft/db";

import type { Account } from "./account.ts";
import type { AuditEntry } from "./audit.ts";
import type { Clock } from "./clock.ts";
import type { CodeMode } from "./code-mode/index.ts";
import type { InstallConfig } from "./config.ts";
import type {
	Component,
	ComponentDeletion,
	ComponentDraftChange,
	ComponentMarkup,
	ComponentUsage,
	DefaultLanguageChange,
	DraftChange,
	Entry,
	EntryDeletion,
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
	PostType,
	PostTypeChange,
	Published,
	PublishItem,
	SaveBase,
	SavedComponentMarkup,
	SavedTemplateMarkup,
	Script,
	SiteLanguages,
	SpecialPages,
	Template,
	TemplateMarkup,
} from "./content/index.ts";
import type { ClassChange, DesignSystemChange, DesignSystemView, EditableClass } from "./design-system/index.ts";
import type { Dns } from "./dns.ts";
import type { Domains } from "./domains/index.ts";
import type { EditMode } from "./edit-mode/index.ts";
import type { Email, Mailer } from "./email/index.ts";
import type { Forms } from "./forms/index.ts";
import type { OutgoingHttp } from "./http.ts";
import type { InstallSettings } from "./install-settings.ts";
import type { JobQueue } from "./jobs/define.ts";
import type { Logger } from "./log.ts";
import type { MasterKeyBackup } from "./master-key-backup.ts";
import type { ImageProcessor, InstallStorage, MediaLibrary } from "./media/index.ts";
import type { ModuleHost } from "./modules/host.ts";
import type { People } from "./people.ts";
import type { PersonActor } from "./permissions/can.ts";
import type { RateLimits } from "./rate-limits.ts";
import type { SiteSearch } from "./search/service.ts";
import type { InstallSecrets } from "./secrets/store.ts";
import type { InstallSetup } from "./setup.ts";
import type { DataSample } from "./site-pages/data-samples.ts";
import type { SitePages } from "./site-pages/index.ts";
import type { SiteScripts } from "./site-scripts/index.ts";
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
	clock: Clock;
	log: Logger;
	/**
	 * Image processing: only the worker (and the test harness, which drains its jobs) has the real
	 * one; the web process and server commands get `imagesOnlyInWorker` (ADR 0027).
	 */
	images: ImageProcessor;
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
	/** Rate limits, counted in Postgres so every web process shares them (`RATE_LIMITS`). */
	rateLimits: RateLimits;
	/** People with an account, and their admin preferences. */
	people: People;
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
		list(scope: SiteScope, postTypeId: string, language?: string): Promise<Entry[]>;
		get(scope: SiteScope, entryId: string, language?: string): Promise<Entry>;
		create(scope: SiteScope, input: NewEntry): Promise<Entry>;
		/** The one way an Entry's Draft changes. */
		saveDraft(scope: SiteScope, entryId: string, change: DraftChange): Promise<Entry>;
		/**
		 * Deletes an Entry in two steps: without `confirmation` it answers how many Entries link to it
		 * and a confirmation id; with the id it deletes it and removes those links. Open the Site with
		 * `entry.delete`.
		 */
		delete(scope: SiteScope, entryId: string, confirmation?: string): Promise<EntryDeletion>;
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
	};
	publishing: {
		/**
		 * Publishes one item: copies its Draft over the published version, clears the Site's page cache
		 * and writes the Audit log. Open the Site with `publishPermission(item)`.
		 */
		publish(scope: SiteScope, item: PublishItem): Promise<Published>;
	};
	/** The Site side: which Site a hostname belongs to, and its published pages. */
	sitePages: SitePages;
	/** Site search's background work: rebuilding search indexes that are behind (ADR 0021). */
	search: SiteSearch;
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
	 * Code mode (ADR 0016): Staff in Edit mode edit the Template markup, CSS and scripts of what they
	 * select on the page, saved to the Drafts. Open its Site with `codeMode.access(session)`.
	 */
	codeMode: CodeMode;
	/** Memberships: Members' roles in a Workspace and the Sites they reach. */
	memberships: MembershipsService;
	/** Members of a Workspace: inviting them, their role and Sites, removing them, pending invites. */
	members: MembersService;
	/** Staff: inviting them, their Workspaces, pending invites. */
	staff: StaffService;
	/** Invite links (Staff and Member invites): what they offer, and accepting them. */
	invites: InvitesService;
	audit: {
		/** The newest entries of the whole Install's Audit log; open the Install with `audit.view` first. */
		list(scope: InstallScope, options: { limit: number }): Promise<AuditEntry[]>;
	};
	/** The Install SMTP, Install branding, the System email sender, the Email log and email preferences. */
	email: Email;
	/** Where the Install stores files (Install settings › Storage), and the storage holding each one. */
	storage: InstallStorage;
	/** Each Site's Media library: uploads, texts and folders. */
	media: MediaLibrary;
	/**
	 * The Module host: the Modules this Install loads, their approvals and switches, and running
	 * them (their procedures, Site routes, events and jobs) within what they declared.
	 */
	modules: ModuleHost;
};
