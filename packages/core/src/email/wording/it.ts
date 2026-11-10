import { wordsIn } from "@webcraft/module-sdk";
import { formatSize } from "./sizes.ts";
import type { EmailWording } from "./types.ts";

const days = (count: number) => (count === 1 ? "1 giorno" : `${count} giorni`);
const minutes = (count: number) => (count === 1 ? "1 minuto" : `${count} minuti`);

const ROLES = { owner: "Owner", editor: "Editor", author: "Author" } as const;

/** System emails in Italian. */
export const it: EmailWording = {
	types: {
		"smtp-test": (_data, { installName }) => ({
			subject: `Email di prova da ${installName}`,
			heading: "Le impostazioni email funzionano",
			paragraphs: [
				`Questa è un'email di prova da ${installName}. È passata dal server SMTP che hai inserito, quindi le email possono arrivare a questo indirizzo.`,
			],
		}),
		"staff-invite": ({ inviterName, acceptPath, expiresInDays }, { installName }) => ({
			subject: `${inviterName} ti ha invitato su ${installName}`,
			heading: "Hai ricevuto un invito",
			paragraphs: [`${inviterName} ti ha invitato a entrare in ${installName} come Staff.`],
			action: { label: "Accetta l'invito", path: acceptPath },
			note: `L'invito vale per ${days(expiresInDays)}. Se non te lo aspettavi, puoi ignorare questa email.`,
		}),
		"member-invite": ({ inviterName, workspaceName, role, acceptPath, expiresInDays }, { installName }) => ({
			subject: `${inviterName} ti ha invitato in ${workspaceName}`,
			heading: "Hai ricevuto un invito",
			paragraphs: [`${inviterName} ti ha invitato in ${workspaceName} su ${installName}, come ${ROLES[role]}.`],
			action: { label: "Accetta l'invito", path: acceptPath },
			note: `L'invito vale per ${days(expiresInDays)}. Se non te lo aspettavi, puoi ignorare questa email.`,
		}),
		"password-reset": ({ resetPath, expiresInMinutes }, { installName }) => ({
			subject: "Reimposta la password",
			heading: "Reimposta la password",
			paragraphs: [
				`Qualcuno ha chiesto di reimpostare la password del tuo account su ${installName}. Se sei stato tu, scegli una nuova password.`,
			],
			action: { label: "Scegli una nuova password", path: resetPath },
			note: `Il link vale per ${minutes(expiresInMinutes)}. Se non l'hai chiesto tu, ignora questa email: la password resta quella di prima.`,
		}),
		"email-change-confirm": ({ newEmail, confirmPath, expiresInMinutes }, { installName }) => ({
			subject: "Conferma il nuovo indirizzo email",
			heading: "Conferma il nuovo indirizzo email",
			paragraphs: [
				`Hai chiesto di accedere a ${installName} con ${newEmail} d'ora in poi. Conferma che questo indirizzo è tuo.`,
			],
			action: { label: "Conferma l'indirizzo", path: confirmPath },
			note: `Il link vale per ${minutes(expiresInMinutes)}. Se non l'hai chiesto tu, ignora questa email.`,
		}),
		"email-change-notice": ({ newEmail }, { installName }) => ({
			subject: "Il tuo indirizzo email sta cambiando",
			heading: "Il tuo indirizzo email sta cambiando",
			paragraphs: [
				`Qualcuno ha chiesto di cambiare l'indirizzo email del tuo account su ${installName} in ${newEmail}.`,
				"Se non sei stato tu, accedi e cambia la password, e avvisa chi gestisce questa Install.",
			],
			action: { label: "Accedi", path: "/sign-in" },
		}),
		"account-locked": ({ failedAttempts, lockedMinutes }, { installName }) => ({
			subject: "Il tuo account è bloccato per un po'",
			heading: "Il tuo account è bloccato per un po'",
			paragraphs: [
				`Dopo ${failedAttempts} tentativi di accesso non riusciti, il tuo account su ${installName} è bloccato per ${minutes(lockedMinutes)}.`,
				"Se sei stato tu, aspetta e riprova. Se non sei stato tu, qualcuno potrebbe provare a indovinare la password: cambiala appena riesci ad accedere.",
			],
		}),
		"two-factor-reset": ({ resetBy }, { installName }) => ({
			subject: "L'autenticazione a due fattori è stata reimpostata",
			heading: "L'autenticazione a due fattori è stata reimpostata",
			paragraphs: [
				resetBy
					? `${resetBy} ha reimpostato l'autenticazione a due fattori del tuo account su ${installName}. Accedi con la password e configurala di nuovo.`
					: `L'autenticazione a due fattori del tuo account su ${installName} è stata reimpostata con un comando sul server. Accedi con la password e configurala di nuovo.`,
				"Se non l'hai chiesto tu, avvisa subito chi gestisce questa Install.",
			],
			action: { label: "Accedi", path: "/sign-in" },
		}),
		"two-factor-changed": ({ method, change }, { installName }) => {
			const what =
				method === "passkey"
					? change === "added"
						? "Una passkey è stata aggiunta al tuo account"
						: "Una passkey è stata rimossa dal tuo account"
					: change === "added"
						? "Un'app di autenticazione è stata aggiunta al tuo account"
						: "Un'app di autenticazione è stata rimossa dal tuo account";
			return {
				subject: what,
				heading: what,
				paragraphs: [
					`${what} su ${installName}.`,
					"Se non sei stato tu, accedi, cambia la password e controlla l'autenticazione a due fattori.",
				],
			};
		},
		"api-token-created": ({ tokenName }, { installName }) => ({
			subject: "È stato creato un nuovo token API",
			heading: "È stato creato un nuovo token API",
			paragraphs: [
				`Il token API “${tokenName}” è stato creato per il tuo account su ${installName}. Gli script che lo usano possono agire al posto tuo.`,
				"Se non l'hai creato tu, accedi ed eliminalo.",
			],
		}),
		"ai-client-approved": ({ clientName }, { installName }) => ({
			subject: `${clientName} ora può agire per te`,
			heading: `${clientName} ora può agire per te`,
			paragraphs: [
				`Il client AI ${clientName} è stato approvato per il tuo account su ${installName}. Ora può fare quello che hai permesso, al posto tuo.`,
				"Se non sei stato tu, accedi e revoca il suo accesso.",
			],
		}),
		"review-submitted": ({ authorName, items, siteName, note, reviewPath }) => {
			const named = elenco(items.map(nomeInRevisione), "e");
			return {
				subject: `${authorName} ha inviato ${named} in revisione`,
				heading: "Pronto per la revisione",
				paragraphs: [
					`${authorName} ha inviato ${named} su ${siteName} in revisione. Pubblicalo, programmalo o rimandalo indietro con un commento.`,
					...(note ? [`La sua nota: ${note}`] : []),
				],
				action: { label: "Rivedilo", path: reviewPath },
			};
		},
		"report-review": ({ reportName, placeName, reviewPath }) => ({
			subject: `“${reportName}” attende la revisione`,
			heading: "Un report attende la revisione",
			paragraphs: [
				`Il report “${reportName}” per ${placeName} è pronto, con un testo dell'IA da verificare. Parte quando qualcuno lo approva.`,
			],
			action: { label: "Rivedilo", path: reviewPath },
		}),
		"review-result": ({ item, siteName, result, reviewerName, comment, scheduledFor, itemPath }) => {
			const named = nomeInRevisione(item);
			// I Globali e i testi del banner del consenso sono plurali.
			const singolare = item.kind === "entry";
			const esito = {
				published: {
					subject: `${maiuscola(named)}: ${singolare ? "pubblicato" : "pubblicati"}`,
					heading: singolare ? "Pubblicato" : "Pubblicati",
					what: `${reviewerName} ha pubblicato ${named} su ${siteName}.`,
				},
				scheduled: {
					subject: `${maiuscola(named)}: pubblicazione programmata`,
					heading: "Pubblicazione programmata",
					what: `${reviewerName} ha programmato la pubblicazione di ${named} su ${siteName} alle ${scheduledFor ?? "un'ora successiva"}.`,
				},
				"sent-back": {
					subject: `${maiuscola(named)}: ${singolare ? "rimandato indietro" : "rimandati indietro"}`,
					heading: singolare ? "Rimandato indietro" : "Rimandati indietro",
					what: `${reviewerName} ti ha rimandato ${named} su ${siteName}. ${
						singolare ? "Modificalo, poi invialo" : "Modificali, poi inviali"
					} di nuovo in revisione.`,
				},
			}[result];
			return {
				subject: esito.subject,
				heading: esito.heading,
				paragraphs: [esito.what, ...(comment ? [`Il suo commento: ${comment}`] : [])],
				action: { label: "Aprilo", path: itemPath },
			};
		},
		"scheduled-publish-failed": ({ siteName, action, itemTitle, count, scheduledFor, reason, path }) => {
			const named = itemTitle ? `“${itemTitle}”` : "un elemento";
			const what =
				action === "unpublish"
					? `La pubblicazione programmata che doveva ritirare ${named} su ${siteName} alle ${scheduledFor} non è andata a buon fine: è ancora pubblicato.`
					: count > 1
						? `La pubblicazione programmata di ${count} elementi su ${siteName} alle ${scheduledFor} non è andata a buon fine, quindi nessuno è stato pubblicato: vanno online insieme o per niente.`
						: `La pubblicazione programmata di ${named} su ${siteName} alle ${scheduledFor} non è andata a buon fine, quindi non è stato pubblicato.`;
			const why: Record<typeof reason, string> = {
				deleted: `${maiuscola(named)} è stato eliminato dopo essere stato programmato.`,
				invalid: `${maiuscola(named)} ha valori che violano una regola, o valori obbligatori vuoti.`,
				pathTaken: `L'indirizzo di ${named} è occupato da qualcosa pubblicato nel frattempo.`,
				parentUnpublished: `La Pagina superiore di ${named} non è pubblicata.`,
				structureChanged: `${maiuscola(named)} usa un Template, un Component, un Field o una Class cambiati o eliminati dopo la programmazione.`,
				access: "Non puoi più pubblicare su questo Sito.",
				homePage: `${maiuscola(named)} è la home page del Sito, o una Pagina sopra di essa.`,
				other: `${maiuscola(named)} non è stato possibile pubblicarlo.`,
			};
			return {
				subject:
					action === "unpublish"
						? `${maiuscola(named)} non è stato ritirato come programmato`
						: `${count > 1 ? `${count} elementi non sono stati pubblicati` : `${maiuscola(named)} non è stato pubblicato`} come programmato`,
				heading: "Una pubblicazione programmata non è andata a buon fine",
				paragraphs: [
					what,
					why[reason],
					"Le bozze sono come prima. Aprile per correggere, poi pubblica o programma di nuovo.",
				],
				action: { label: "Apri", path },
			};
		},
		"ai-key-cap": ({ workspaceName, percent, usagePath }) =>
			percent === 100
				? {
						subject: `${workspaceName} ha raggiunto il limite AI mensile`,
						heading: "Il limite AI mensile è raggiunto",
						paragraphs: [
							`${workspaceName} ha usato tutto il limite di questo mese sulla sua chiave AI, quindi la traduzione AI si è fermata. Nulla resta scritto a metà: il lavoro in coda aspetta che il limite venga alzato o che finisca il mese.`,
						],
						action: { label: "Vedi l'uso dell'AI", path: usagePath },
					}
				: {
						subject: `${workspaceName} ha usato l'80% del limite AI mensile`,
						heading: "È stato usato l'80% del limite AI mensile",
						paragraphs: [
							`${workspaceName} ha usato l'80% del limite di questo mese sulla sua chiave AI. La traduzione AI si ferma al 100%, finché il limite non viene alzato o finisce il mese.`,
						],
						action: { label: "Vedi l'uso dell'AI", path: usagePath },
					},
		"domain-unreachable": ({ domain, siteName, domainsPath }) => ({
			subject: `${domain} non è raggiungibile`,
			heading: `${domain} non è raggiungibile`,
			paragraphs: [
				`Il Domain check non è riuscito a raggiungere ${siteName} su ${domain}. Il dominio potrebbe puntare altrove, oppure il suo certificato potrebbe mancare o essere in scadenza.`,
			],
			action: { label: "Controlla i domini", path: domainsPath },
		}),
		"media-quota-warning": ({ workspaceName, percent, usedBytes, quotaBytes, workspacePath }) => ({
			subject: `${workspaceName} ha usato il ${percent}% dello spazio per i Media`,
			heading: `È usato il ${percent}% dello spazio per i Media`,
			paragraphs: [
				`Le librerie Media dei Siti di ${workspaceName} occupano ${formatSize(usedBytes, ",")} su ${formatSize(quotaBytes, ",")}. I caricamenti che supererebbero la quota vengono rifiutati.`,
				"Elimina i file che non servono più (svuotare il Cestino libera subito il loro spazio), oppure chiedi una quota più grande.",
			],
			action: { label: "Vedi lo spazio", path: workspacePath },
		}),
		"report-failed": ({ reportName, placeName, reportsPath }) => ({
			subject: `Non è stato possibile inviare “${reportName}”`,
			heading: "Non è stato possibile inviare un report",
			paragraphs: [
				`Il PDF del report “${reportName}” per ${placeName} non è stato creato dopo tre tentativi, quindi non è stato inviato a nessuno.`,
				"La sua cronologia spiega perché. Inviatelo di nuovo da lì quando il problema è risolto.",
			],
			action: { label: "Apri la cronologia", path: reportsPath },
		}),
		"webhook-switched-off": ({ webhookName, host, siteName, failures, webhooksPath }) => ({
			subject: `Un Webhook di ${siteName} è stato disattivato`,
			heading: "Un Webhook è stato disattivato",
			paragraphs: [
				`Il Webhook ${webhookName} di ${siteName}, verso ${host}, non è riuscito a consegnare ${failures} volte di seguito, quindi è stato disattivato: non riceve nulla finché non viene riattivato.`,
				"Quando il sistema che chiama torna a funzionare, riattivalo e consegna di nuovo dal suo registro delle consegne ciò che ha perso.",
			],
			action: { label: "Apri i Webhook", path: webhooksPath },
		}),
		"module-message": ({ moduleName, languages, subject, heading, paragraphs, action }) => {
			const words = (label: Readonly<Record<string, string>>) => wordsIn(label, "it", languages);
			return {
				subject: words(subject),
				heading: words(heading),
				paragraphs: [...paragraphs.map(words), `Inviata dal Modulo ${words(moduleName)}.`],
				...(action ? { action: { label: words(action.label), path: action.path } } : {}),
			};
		},
		"site-smtp-failing": ({ siteName, lastResponse, settingsPath }) => ({
			subject: `L'SMTP di ${siteName} non funziona`,
			heading: `L'SMTP di ${siteName} non funziona`,
			paragraphs: [
				`Le ultime 3 email che ${siteName} ha provato a inviare con il proprio server SMTP non sono partite. Ognuna viene riprovata per circa 24 ore.`,
				`L'ultima risposta del server: ${lastResponse}`,
			],
			action: { label: "Controlla le impostazioni email", path: settingsPath },
		}),
	},
	layout: {
		linkHint: "Se il pulsante non funziona, copia questo indirizzo nel browser:",
		sentBy: (installName) => `Inviata da ${installName}.`,
		preferences: "Scegli quali email ricevere",
	},
};

/** La prima lettera di una frase in maiuscolo. */
/** Come le email della revisione nominano un elemento: una Entry con il suo titolo; i Globali e i testi del banner del consenso per quello che sono. */
function nomeInRevisione(item: { kind: "entry" | "globals" | "consentBanner"; title: string | null }): string {
	if (item.kind === "globals") return "i Globali";
	if (item.kind === "consentBanner") return "i testi del Banner del consenso";
	return item.title ? `“${item.title}”` : "una Entry senza titolo";
}

/** Nomi uniti come in una frase: “A”, “B” e “C”. */
function elenco(nomi: readonly string[], e: string): string {
	if (nomi.length <= 1) return nomi[0] ?? "";
	return `${nomi.slice(0, -1).join(", ")} ${e} ${nomi.at(-1)}`;
}

function maiuscola(testo: string): string {
	return testo.charAt(0).toUpperCase() + testo.slice(1);
}
