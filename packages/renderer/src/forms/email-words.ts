/**
 * The words WebCraft itself writes into a Form's emails, by language: a Notification's default
 * subject and intro and the labels around a Submission's values (in the Site's Default language),
 * and the line an Auto-reply ends with (in the visitor's language). English, Italian, French,
 * German, Spanish, Portuguese and Dutch, by the language's primary subtag; English for any other.
 * `{form}`, `{site}` and `{email}` are filled in. This file imports nothing, so the admin shows the
 * same defaults the emails use.
 */
export type FormEmailWords = {
	/** A Notification's subject when its own is empty. */
	subject: string;
	/** A Notification's opening line when its own is empty. */
	intro: string;
	form: string;
	page: string;
	language: string;
	received: string;
	/** Shown for a value left empty. */
	empty: string;
	yes: string;
	no: string;
	/** The link to the Submission in the admin. */
	open: string;
	/** Below a Notification whose replies go to the visitor. */
	replyHint: string;
	/** The last line of an Auto-reply. */
	autoReplyFooter: string;
};

const WORDS: Readonly<Record<string, FormEmailWords>> = {
	en: {
		subject: "New Submission: {form}",
		intro: "Someone filled in the Form {form} on {site}.",
		form: "Form",
		page: "Page",
		language: "Language",
		received: "Received",
		empty: "—",
		yes: "Yes",
		no: "No",
		open: "Open it in the admin",
		replyHint: "Reply to this email to answer {email}.",
		autoReplyFooter: "You get this email because this address was given in a form on {site}.",
	},
	it: {
		subject: "Nuovo invio: {form}",
		intro: "Qualcuno ha compilato il modulo {form} su {site}.",
		form: "Modulo",
		page: "Pagina",
		language: "Lingua",
		received: "Ricevuto",
		empty: "—",
		yes: "Sì",
		no: "No",
		open: "Aprilo nell'amministrazione",
		replyHint: "Rispondi a questa email per rispondere a {email}.",
		autoReplyFooter: "Ricevi questa email perché questo indirizzo è stato indicato in un modulo su {site}.",
	},
	fr: {
		subject: "Nouvel envoi : {form}",
		intro: "Quelqu'un a rempli le formulaire {form} sur {site}.",
		form: "Formulaire",
		page: "Page",
		language: "Langue",
		received: "Reçu",
		empty: "—",
		yes: "Oui",
		no: "Non",
		open: "L'ouvrir dans l'administration",
		replyHint: "Répondez à cet e-mail pour répondre à {email}.",
		autoReplyFooter: "Vous recevez cet e-mail car cette adresse a été indiquée dans un formulaire sur {site}.",
	},
	de: {
		subject: "Neue Einsendung: {form}",
		intro: "Jemand hat das Formular {form} auf {site} ausgefüllt.",
		form: "Formular",
		page: "Seite",
		language: "Sprache",
		received: "Eingegangen",
		empty: "—",
		yes: "Ja",
		no: "Nein",
		open: "In der Verwaltung öffnen",
		replyHint: "Antworten Sie auf diese E-Mail, um {email} zu antworten.",
		autoReplyFooter: "Sie erhalten diese E-Mail, weil diese Adresse in einem Formular auf {site} angegeben wurde.",
	},
	es: {
		subject: "Nuevo envío: {form}",
		intro: "Alguien ha rellenado el formulario {form} en {site}.",
		form: "Formulario",
		page: "Página",
		language: "Idioma",
		received: "Recibido",
		empty: "—",
		yes: "Sí",
		no: "No",
		open: "Ábrelo en la administración",
		replyHint: "Responde a este correo para contestar a {email}.",
		autoReplyFooter: "Recibes este correo porque esta dirección se indicó en un formulario de {site}.",
	},
	pt: {
		subject: "Novo envio: {form}",
		intro: "Alguém preencheu o formulário {form} em {site}.",
		form: "Formulário",
		page: "Página",
		language: "Idioma",
		received: "Recebido",
		empty: "—",
		yes: "Sim",
		no: "Não",
		open: "Abrir na administração",
		replyHint: "Responda a este e-mail para responder a {email}.",
		autoReplyFooter: "Recebe este e-mail porque este endereço foi indicado num formulário em {site}.",
	},
	nl: {
		subject: "Nieuwe inzending: {form}",
		intro: "Iemand heeft het formulier {form} op {site} ingevuld.",
		form: "Formulier",
		page: "Pagina",
		language: "Taal",
		received: "Ontvangen",
		empty: "—",
		yes: "Ja",
		no: "Nee",
		open: "Openen in het beheer",
		replyHint: "Beantwoord deze e-mail om {email} te antwoorden.",
		autoReplyFooter: "U ontvangt deze e-mail omdat dit adres is opgegeven in een formulier op {site}.",
	},
};

/** The words of a Form's emails in a language (by its primary subtag), English for any other. */
export function formEmailWords(language: string | undefined): FormEmailWords {
	const primary = (language ?? "en").split("-")[0]?.toLowerCase() ?? "en";
	return WORDS[primary] ?? (WORDS.en as FormEmailWords);
}

/** Words with `{form}`, `{site}` and `{email}` filled in. */
export function fillEmailWords(text: string, values: Readonly<Partial<Record<"form" | "site" | "email", string>>>) {
	return text.replace(/\{(form|site|email)\}/g, (_, name: "form" | "site" | "email") => values[name] ?? "");
}
