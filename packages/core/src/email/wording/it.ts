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
				`${resetBy} ha reimpostato l'autenticazione a due fattori del tuo account su ${installName}. Accedi con la password e configurala di nuovo.`,
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
		"review-submitted": ({ authorName, itemTitle, siteName, reviewPath }) => ({
			subject: `${authorName} ha inviato “${itemTitle}” in revisione`,
			heading: "Pronto per la revisione",
			paragraphs: [`${authorName} ha inviato “${itemTitle}” su ${siteName} in revisione.`],
			action: { label: "Rivedilo", path: reviewPath },
		}),
		"review-result": ({ itemTitle, siteName, result, reviewerName, comment, itemPath }) => {
			const published = result === "published";
			return {
				subject: published ? `“${itemTitle}” è stato pubblicato` : `“${itemTitle}” ti è stato rimandato`,
				heading: published ? "Pubblicato" : "Rimandato indietro",
				paragraphs: [
					published
						? `${reviewerName} ha pubblicato “${itemTitle}” su ${siteName}.`
						: `${reviewerName} ti ha rimandato “${itemTitle}” su ${siteName}.`,
					...(comment ? [`Il suo commento: ${comment}`] : []),
				],
				action: { label: "Aprilo", path: itemPath },
			};
		},
		"scheduled-publish-failed": ({ itemTitle, siteName, itemPath }) => ({
			subject: `“${itemTitle}” non è stato pubblicato come programmato`,
			heading: "Una pubblicazione programmata non è andata a buon fine",
			paragraphs: [
				`La pubblicazione programmata di “${itemTitle}” su ${siteName} non è andata a buon fine. Aprilo per vedere perché e pubblicalo di nuovo.`,
			],
			action: { label: "Aprilo", path: itemPath },
		}),
		"ai-key-cap": ({ workspaceName, percent, usagePath }) =>
			percent === 100
				? {
						subject: `${workspaceName} ha raggiunto il limite AI mensile`,
						heading: "Il limite AI mensile è raggiunto",
						paragraphs: [
							`${workspaceName} ha usato tutto il limite di questo mese sulla chiave AI condivisa, quindi la traduzione AI si è fermata. Il lavoro in coda aspetta che il limite venga alzato o che finisca il mese.`,
						],
						action: { label: "Vedi l'uso dell'AI", path: usagePath },
					}
				: {
						subject: `${workspaceName} ha usato l'80% del limite AI mensile`,
						heading: "È stato usato l'80% del limite AI mensile",
						paragraphs: [
							`${workspaceName} ha usato l'80% del limite di questo mese sulla chiave AI condivisa. La traduzione AI si ferma al 100%, finché il limite non viene alzato o finisce il mese.`,
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
