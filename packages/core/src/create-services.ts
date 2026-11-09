import { createAuth, leakedPasswordCheck } from "@webcraft/auth";
import type { ModuleDefinition } from "@webcraft/module-sdk";

import { createAccount, reportAccountLock } from "./account.ts";
import { createApiTokens } from "./api-tokens.ts";
import { listAuditEntries } from "./audit.ts";
import { createBackups } from "./backups/service.ts";
import { createBuilder } from "./builder/index.ts";
import { createCdns } from "./cdns/index.ts";
import { createCodeMode } from "./code-mode/index.ts";
import { createConsent } from "./consent/index.ts";
import {
	addLanguage,
	createComponent,
	createEntry,
	createLoop,
	createPostType,
	deleteComponent,
	deleteEntry,
	getArchiveTemplate,
	getArchiveTemplateMarkup,
	getComponent,
	getComponentMarkup,
	getEntry,
	getEntryTemplate,
	getEntryTemplateMarkup,
	getGlobals,
	getLoop,
	getPostType,
	getScript,
	getSearchTemplate,
	getSearchTemplateMarkup,
	getSiteTemplate,
	getSiteTemplateMarkup,
	getSpecialPages,
	listComponents,
	listEntries,
	listLoops,
	listPostTypes,
	listTemplates,
	publish,
	publishPreview,
	removeLanguage,
	renameComponent,
	saveArchiveTemplate,
	saveArchiveTemplateMarkup,
	saveComponentDraft,
	saveComponentMarkup,
	saveDraft,
	saveEntryTemplate,
	saveEntryTemplateMarkup,
	saveGlobalsDraft,
	saveLoopDraft,
	saveLoopItems,
	saveScriptDraft,
	saveSearchTemplate,
	saveSearchTemplateMarkup,
	saveSiteTemplate,
	saveSiteTemplateMarkup,
	scriptById,
	setBrowserLanguageRedirect,
	setDefaultLanguage,
	setGlobalFields,
	setSpecialPage,
	siteLanguages,
	updateLanguage,
	updatePostType,
} from "./content/index.ts";
import {
	createClass,
	deleteClass,
	exportDesignTokens,
	getDesignSystem,
	importDesignTokens,
	saveDesignSystemDraft,
	updateClass,
} from "./design-system/drafts.ts";
import { createDomains } from "./domains/index.ts";
import { createEditMode } from "./edit-mode/index.ts";
import { createEmail } from "./email/index.ts";
import { createForms, createFormTokens } from "./forms/index.ts";
import { createSubmissionActions } from "./forms/kept.ts";
import { createGuardedFetch } from "./guarded-fetch.ts";
import { createImports } from "./imports/index.ts";
import { createInstallSettings, MEDIA_MAX_FILE_BYTES } from "./install-settings.ts";
import { createMasterKeyBackup } from "./master-key-backup.ts";
import { MEDIA_IMPORT_TIMEOUT_MS } from "./media/import.ts";
import { createInstallStorage } from "./media/install-storage.ts";
import { createMediaLibrary } from "./media/library.ts";
import { FIRST_PARTY_MODULES } from "./modules/first-party.ts";
import { createModuleHost, type ModuleHost } from "./modules/host.ts";
import { createPeople } from "./people.ts";
import { loadPersonActor } from "./permissions/actors.ts";
import { createRateLimits } from "./rate-limits.ts";
import { createSiteSearch } from "./search/service.ts";
import {
	apiTokenKey,
	domainVerificationKey,
	editModeSigningKey,
	formTimeKey,
	type MasterKey,
	rateLimitKey,
	sessionSigningSecret,
	visitorIdKey,
} from "./secrets/master-key.ts";
import { createSecrets, installSecretsOnly, openSecrets } from "./secrets/store.ts";
import { createSeo } from "./seo/index.ts";
import type { InstallPorts, InstallServices } from "./services.ts";
import { createInstallSetup } from "./setup.ts";
import { entryTemplateData, globalsData, loopData } from "./site-pages/data-samples.ts";
import { createSitePages, reservedSlugs, stagingUrl } from "./site-pages/index.ts";
import { createSiteScripts } from "./site-scripts/index.ts";
import { createDataLayer } from "./tenancy/data-layer.ts";
import { createInvites } from "./tenancy/invites.ts";
import { createMembers } from "./tenancy/members.ts";
import { createMemberships } from "./tenancy/memberships.ts";
import { createSite, listSites } from "./tenancy/sites.ts";
import { createStaff } from "./tenancy/staff.ts";
import { createWorkspace, listWorkspaces } from "./tenancy/workspaces.ts";
import { createUpdates } from "./updates.ts";
import { createWebhooks } from "./webhooks/index.ts";

export type CreateServicesOptions = {
	/** The Modules this Install loads: the first-party Modules of this build unless given. */
	modules?: readonly ModuleDefinition[];
	/** How long Import from URL waits for a file; 30 seconds unless given (the test harness waits less). */
	mediaImportTimeoutMs?: number;
	/**
	 * Refuse a Master key that isn't the Install's current one, as web and worker do when they
	 * start (default). Only code that must not read the database yet turns this off.
	 */
	checkMasterKey?: boolean;
};

/**
 * Builds an Install's services on top of its ports and Master key. Web, worker and the test harness
 * all build them here, so they work the same way everywhere.
 */
export async function createInstallServices(
	ports: InstallPorts,
	masterKey: MasterKey,
	options: CreateServicesOptions = {},
): Promise<InstallServices> {
	const { database, clock, log, config } = ports;
	const secretsOptions = { database, masterKey, clock };
	// Every secret; the data layer hands out a Workspace's or a Site's, `services.secrets` the Install's.
	const store = options.checkMasterKey === false ? createSecrets(secretsOptions) : await openSecrets(secretsOptions);
	const settings = createInstallSettings(database);
	const installSecrets = installSecretsOnly(store);
	// The Module host and Webhooks hear of every Audit log entry once its change is saved: Modules
	// react to some, and a publish fires the Site's Webhooks.
	const listeners: { afterAudit: ModuleHost["afterAudit"][] } = { afterAudit: [] };
	const data = createDataLayer({
		database,
		clock,
		secrets: store,
		afterAudit: async (entry) => {
			for (const listener of listeners.afterAudit) await listener(entry);
		},
	});
	// Email reads the Install SMTP's password and a Site's own server's, each only for its send.
	const email = createEmail({ ...ports, secrets: store, settings, data });
	const auth = createAuth({
		database,
		clock,
		adminOrigin: config.adminOrigin,
		secret: await sessionSigningSecret(masterKey),
		log,
		passwordChecks: [
			leakedPasswordCheck({
				http: ports.http,
				log,
				enabled: async () => (await settings.security()).leakedPasswordCheck,
			}),
		],
		onAccountLocked: reportAccountLock({ database, clock, email }),
	});
	const guardedFetch = createGuardedFetch({ http: ports.http, dns: ports.dns });
	const webhooks = createWebhooks({
		config,
		database,
		data,
		secrets: store,
		fetch: guardedFetch,
		jobs: ports.jobs,
		clock,
		log,
		email,
	});
	const rateLimits = createRateLimits({ database, clock, log, keyHash: await rateLimitKey(masterKey) });
	const modules = createModuleHost({
		database,
		data,
		email,
		jobs: ports.jobs,
		fetch: guardedFetch,
		clock,
		log,
		modules: options.modules ?? FIRST_PARTY_MODULES,
		// What follows a kept Form Submission: its Notifications, Auto-reply and Webhooks.
		submissionActions: createSubmissionActions({ data, email, webhooks, clock, log }),
		rateLimits,
		countries: ports.countries,
		visitorIdKey: await visitorIdKey(masterKey),
	});
	listeners.afterAudit.push(modules.afterAudit, webhooks.afterAudit);
	// The Components of Modules: placed on Sites where their Module runs.
	const componentSources = modules.components;
	const actors = { person: (personId: string) => loadPersonActor(database.db, personId) };
	const people = createPeople({ database, clock });
	const apiTokens = createApiTokens({ database, clock, people, rateLimits, keyHash: await apiTokenKey(masterKey) });
	const memberships = createMemberships({ database, clock });
	const storage = createInstallStorage({
		database,
		secrets: installSecrets,
		http: ports.http,
		clock,
		log,
		directory: config.storageDir,
	});
	const media = createMediaLibrary({
		storage,
		jobs: ports.jobs,
		settings,
		email,
		log,
		clock,
		ai: ports.ai,
		fetch: createGuardedFetch({
			http: ports.http,
			dns: ports.dns,
			ceilings: { maxBytes: MEDIA_MAX_FILE_BYTES.max, timeoutMs: MEDIA_IMPORT_TIMEOUT_MS },
		}),
		importTimeoutMs: options.mediaImportTimeoutMs,
	});
	const formTokens = createFormTokens({ key: await formTimeKey(masterKey), clock });
	const sitePages = createSitePages({
		database,
		config,
		data,
		storage,
		components: componentSources,
		formsOn: async (site) => (await modules.submissionsKeptBy(site)) !== null,
		formToken: (site) => formTokens.issue(site.id),
		moduleHosts: async (site) => (await modules.outsideHostsAt(site, "en")).map((found) => found.host),
		moduleScripts: (site) => modules.siteScriptsAt(site),
		redirects: (site, request, paths) => modules.redirectFor(site, request, paths),
		misses: { keeps: modules.keepsNotFoundLog, note: (site, miss) => modules.noteMiss(site, miss) },
	});
	return {
		...ports,
		secrets: installSecrets,
		auth,
		account: createAccount({ database, auth, clock }),
		rateLimits,
		people,
		apiTokens,
		setup: createInstallSetup({ database, auth, config, clock, log }),
		settings,
		masterKey: createMasterKeyBackup({ database, clock, log, fingerprint: await masterKey.fingerprint() }),
		data,
		actors,
		workspaces: {
			list: (access) => listWorkspaces(database, access),
			create: createWorkspace,
		},
		sites: {
			list: listSites,
			create: (scope, input) => createSite(scope, input, reservedSlugs(config)),
			stagingUrl: (site) => stagingUrl(config, site.slug),
		},
		postTypes: {
			list: listPostTypes,
			get: getPostType,
			create: createPostType,
			update: updatePostType,
			data: entryTemplateData,
		},
		entries: { list: listEntries, get: getEntry, create: createEntry, saveDraft, delete: deleteEntry },
		globals: { get: getGlobals, setFields: setGlobalFields, saveDraft: saveGlobalsDraft, data: globalsData },
		templates: {
			list: listTemplates,
			entryTemplate: getEntryTemplate,
			saveEntryTemplate: (scope, postTypeId, tree) => saveEntryTemplate(scope, postTypeId, tree, componentSources),
			entryTemplateMarkup: (scope, postTypeId) => getEntryTemplateMarkup(scope, postTypeId, componentSources),
			saveEntryTemplateMarkup: (scope, postTypeId, markup, base) =>
				saveEntryTemplateMarkup(scope, postTypeId, markup, componentSources, base),
			siteTemplate: getSiteTemplate,
			saveSiteTemplate: (scope, tree) => saveSiteTemplate(scope, tree, componentSources),
			siteTemplateMarkup: (scope) => getSiteTemplateMarkup(scope, componentSources),
			saveSiteTemplateMarkup: (scope, markup, base) => saveSiteTemplateMarkup(scope, markup, componentSources, base),
			archiveTemplate: getArchiveTemplate,
			saveArchiveTemplate: (scope, postTypeId, tree) => saveArchiveTemplate(scope, postTypeId, tree, componentSources),
			archiveTemplateMarkup: (scope, postTypeId) => getArchiveTemplateMarkup(scope, postTypeId, componentSources),
			saveArchiveTemplateMarkup: (scope, postTypeId, markup, base) =>
				saveArchiveTemplateMarkup(scope, postTypeId, markup, componentSources, base),
			searchTemplate: getSearchTemplate,
			saveSearchTemplate: (scope, tree) => saveSearchTemplate(scope, tree, componentSources),
			searchTemplateMarkup: (scope) => getSearchTemplateMarkup(scope, componentSources),
			saveSearchTemplateMarkup: (scope, markup, base) =>
				saveSearchTemplateMarkup(scope, markup, componentSources, base),
		},
		components: {
			list: (scope) => listComponents(scope, componentSources),
			get: (scope, componentId) => getComponent(scope, componentId, componentSources),
			create: (scope, input) => createComponent(scope, input, componentSources),
			saveDraft: (scope, componentId, change) => saveComponentDraft(scope, componentId, change, componentSources),
			markup: (scope, componentId) => getComponentMarkup(scope, componentId, componentSources),
			saveMarkup: (scope, componentId, input, base) =>
				saveComponentMarkup(scope, componentId, input, componentSources, base),
			rename: (scope, componentId, name) => renameComponent(scope, componentId, name, componentSources),
			delete: (scope, componentId, confirmation) => deleteComponent(scope, componentId, confirmation, componentSources),
		},
		forms: createForms({
			data,
			modules,
			rateLimits,
			tokens: formTokens,
			fetch: createGuardedFetch({ http: ports.http, dns: ports.dns }),
			clock,
			log,
		}),
		loops: {
			list: listLoops,
			get: getLoop,
			create: createLoop,
			saveDraft: saveLoopDraft,
			saveItems: saveLoopItems,
			data: loopData,
		},
		domains: createDomains({
			config,
			database,
			data,
			http: ports.http,
			dns: ports.dns,
			tls: ports.tls,
			clock,
			log,
			email,
			verificationKey: await domainVerificationKey(masterKey),
		}),
		cdns: createCdns({ database, clock, log, jobs: ports.jobs, fetch: guardedFetch }),
		webhooks,
		scripts: { get: getScript, byId: scriptById, saveDraft: saveScriptDraft },
		languages: {
			get: siteLanguages,
			add: (scope, input) => addLanguage({ config }, scope, input),
			update: (scope, code, change) => updateLanguage({ config }, scope, code, change),
			setDefault: setDefaultLanguage,
			remove: removeLanguage,
			setBrowserRedirect: setBrowserLanguageRedirect,
		},
		pages: {
			settings: getSpecialPages,
			setHomePage: (scope, pageId) => setSpecialPage(scope, "home", pageId),
			setNotFoundPage: (scope, pageId, language) => setSpecialPage(scope, "notFound", pageId, language),
			setSearchPage: (scope, pageId) => setSpecialPage(scope, "search", pageId),
		},
		designSystem: {
			get: getDesignSystem,
			saveDraft: saveDesignSystemDraft,
			createClass,
			updateClass,
			deleteClass,
			exportTokens: exportDesignTokens,
			importTokens: importDesignTokens,
		},
		publishing: { publish: (scope, item) => publish(scope, item, componentSources), preview: publishPreview },
		sitePages,
		search: createSiteSearch({ database, data, clock, log }),
		consent: createConsent({ data, rateLimits }),
		seo: createSeo(),
		siteScripts: createSiteScripts({ fetch: guardedFetch, storage, moduleHosts: modules.outsideHostsAt }),
		editMode: createEditMode({
			database,
			clock,
			config,
			auth,
			data,
			actors,
			signingKey: await editModeSigningKey(masterKey),
			pageContent: (host, pathname) => sitePages.pageContent(host, pathname),
		}),
		codeMode: createCodeMode({ data, sources: componentSources, pages: sitePages }),
		builder: createBuilder({ sources: componentSources }),
		memberships,
		members: createMembers({ database, email }),
		staff: createStaff({ email }),
		invites: createInvites({ database, auth, settings, clock, memberships }),
		audit: { list: (scope, options) => listAuditEntries(scope.db, options) },
		email,
		storage,
		media,
		imports: createImports({ storage, jobs: ports.jobs }),
		modules,
		backups: createBackups({
			config,
			database,
			secrets: installSecrets,
			http: ports.http,
			clock,
			log,
			fingerprint: await masterKey.fingerprint(),
			modules: options.modules ?? FIRST_PARTY_MODULES,
		}),
		updates: createUpdates({ database, feed: config.updateFeed, fetch: guardedFetch, clock, log }),
	};
}
