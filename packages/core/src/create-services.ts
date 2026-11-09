import { createAuth, leakedPasswordCheck } from "@webcraft/auth";
import type { ModuleDefinition } from "@webcraft/module-sdk";

import { createAccount, reportAccountLock } from "./account.ts";
import { listAuditEntries } from "./audit.ts";
import { createCodeMode } from "./code-mode/index.ts";
import { createConsent } from "./consent/index.ts";
import {
	addLanguage,
	createComponent,
	createEntry,
	createPostType,
	deleteComponent,
	deleteEntry,
	getComponent,
	getComponentMarkup,
	getEntry,
	getEntryTemplate,
	getEntryTemplateMarkup,
	getGlobals,
	getPostType,
	getScript,
	getSiteTemplate,
	getSiteTemplateMarkup,
	getSpecialPages,
	listComponents,
	listEntries,
	listPostTypes,
	publish,
	removeLanguage,
	renameComponent,
	saveComponentDraft,
	saveComponentMarkup,
	saveDraft,
	saveEntryTemplate,
	saveEntryTemplateMarkup,
	saveGlobalsDraft,
	saveScriptDraft,
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
import { createGuardedFetch } from "./guarded-fetch.ts";
import { createInstallSettings } from "./install-settings.ts";
import { createMasterKeyBackup } from "./master-key-backup.ts";
import { createInstallStorage } from "./media/install-storage.ts";
import { createMediaLibrary } from "./media/library.ts";
import { FIRST_PARTY_MODULES } from "./modules/first-party.ts";
import { createModuleHost, type ModuleHost } from "./modules/host.ts";
import { createPeople } from "./people.ts";
import { loadPersonActor } from "./permissions/actors.ts";
import { createRateLimits } from "./rate-limits.ts";
import {
	domainVerificationKey,
	editModeSigningKey,
	formTimeKey,
	type MasterKey,
	sessionSigningSecret,
} from "./secrets/master-key.ts";
import { createSecrets, installSecretsOnly, openSecrets } from "./secrets/store.ts";
import type { InstallPorts, InstallServices } from "./services.ts";
import { createInstallSetup } from "./setup.ts";
import { createSitePages, reservedSlugs, stagingUrl } from "./site-pages/index.ts";
import { createSiteScripts } from "./site-scripts/index.ts";
import { createDataLayer } from "./tenancy/data-layer.ts";
import { createInvites } from "./tenancy/invites.ts";
import { createMembers } from "./tenancy/members.ts";
import { createMemberships } from "./tenancy/memberships.ts";
import { createSite, listSites } from "./tenancy/sites.ts";
import { createStaff } from "./tenancy/staff.ts";
import { createWorkspace, listWorkspaces } from "./tenancy/workspaces.ts";

export type CreateServicesOptions = {
	/** The Modules this Install loads: the first-party Modules of this build unless given. */
	modules?: readonly ModuleDefinition[];
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
	const email = createEmail({ ...ports, secrets: installSecrets, settings });
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
	// The Module host hears of every Audit log entry once its change is saved: Modules react to some.
	const listeners: { afterAudit?: ModuleHost["afterAudit"] } = {};
	const data = createDataLayer({
		database,
		clock,
		secrets: store,
		afterAudit: (entry) => listeners.afterAudit?.(entry) ?? Promise.resolve(),
	});
	const guardedFetch = createGuardedFetch({ http: ports.http, dns: ports.dns });
	const modules = createModuleHost({
		database,
		data,
		email,
		jobs: ports.jobs,
		fetch: guardedFetch,
		clock,
		log,
		modules: options.modules ?? FIRST_PARTY_MODULES,
	});
	listeners.afterAudit = modules.afterAudit;
	// The Components of Modules: placed on Sites where their Module runs.
	const componentSources = modules.components;
	const actors = { person: (personId: string) => loadPersonActor(database.db, personId) };
	const memberships = createMemberships({ database, clock });
	const storage = createInstallStorage({
		database,
		secrets: installSecrets,
		http: ports.http,
		clock,
		log,
		directory: config.storageDir,
	});
	const rateLimits = createRateLimits({ database, clock, log });
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
	});
	return {
		...ports,
		secrets: installSecrets,
		auth,
		account: createAccount({ database, auth, clock }),
		rateLimits,
		people: createPeople({ database, clock }),
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
		postTypes: { list: listPostTypes, get: getPostType, create: createPostType, update: updatePostType },
		entries: { list: listEntries, get: getEntry, create: createEntry, saveDraft, delete: deleteEntry },
		globals: { get: getGlobals, setFields: setGlobalFields, saveDraft: saveGlobalsDraft },
		templates: {
			entryTemplate: getEntryTemplate,
			saveEntryTemplate: (scope, postTypeId, tree) => saveEntryTemplate(scope, postTypeId, tree, componentSources),
			entryTemplateMarkup: (scope, postTypeId) => getEntryTemplateMarkup(scope, postTypeId, componentSources),
			saveEntryTemplateMarkup: (scope, postTypeId, markup, base) =>
				saveEntryTemplateMarkup(scope, postTypeId, markup, componentSources, base),
			siteTemplate: getSiteTemplate,
			saveSiteTemplate: (scope, tree) => saveSiteTemplate(scope, tree, componentSources),
			siteTemplateMarkup: (scope) => getSiteTemplateMarkup(scope, componentSources),
			saveSiteTemplateMarkup: (scope, markup, base) => saveSiteTemplateMarkup(scope, markup, componentSources, base),
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
		publishing: { publish: (scope, item) => publish(scope, item, componentSources) },
		sitePages,
		consent: createConsent({ data, rateLimits }),
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
		memberships,
		members: createMembers({ database, email }),
		staff: createStaff({ email }),
		invites: createInvites({ database, auth, settings, clock, memberships }),
		audit: { list: (scope, options) => listAuditEntries(scope.db, options) },
		email,
		storage,
		media: createMediaLibrary({ storage, jobs: ports.jobs }),
		modules,
	};
}
