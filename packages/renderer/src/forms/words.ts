/**
 * The words WebCraft itself writes into Forms, by language: what a new Form starts with (its button,
 * its message once sent), the error summary, the honeypot's label, and an error for each rule a value
 * can break. English, Italian, French, German, Spanish, Portuguese and Dutch, by the language's
 * primary subtag; English for any other. Staff replace a field's errors with their own (`message`),
 * in every language they like.
 */
export type FormWords = {
	send: string;
	sent: string;
	choose: string;
	required: string;
	problemTitle: string;
	errorPrefix: string;
	honeypot: string;
	captcha: string;
	errors: Readonly<Record<FormRule, string>>;
};

/**
 * The rules a sent value can break: what the error says. `{min}`, `{max}` and `{count}` are filled in
 * from the field's settings.
 */
export type FormRule =
	| "required"
	| "requiredChoice"
	| "requiredConsent"
	| "email"
	| "phone"
	| "url"
	| "number"
	| "integer"
	| "min"
	| "max"
	| "date"
	| "minDate"
	| "maxDate"
	| "minLength"
	| "maxLength"
	| "pattern"
	| "option"
	| "minChoices"
	| "maxChoices";

const WORDS: Readonly<Record<string, FormWords>> = {
	en: {
		send: "Send",
		sent: "Thank you. We have received your message.",
		choose: "Choose…",
		required: "Required fields are marked *",
		problemTitle: "There is a problem",
		errorPrefix: "Error:",
		honeypot: "Leave this field empty",
		captcha: "Complete the check before sending.",
		errors: {
			required: "Enter a value.",
			requiredChoice: "Choose an option.",
			requiredConsent: "Tick this box to continue.",
			email: "Enter an email address, such as name@example.com.",
			phone: "Enter a phone number, such as +353 1 234 5678.",
			url: "Enter a web address starting with https://.",
			number: "Enter a number.",
			integer: "Enter a whole number.",
			min: "Enter {min} or more.",
			max: "Enter {max} or less.",
			date: "Enter a date, such as 2026-03-02.",
			minDate: "Enter {min} or later.",
			maxDate: "Enter {max} or earlier.",
			minLength: "Enter at least {min} characters.",
			maxLength: "Enter {max} characters or fewer.",
			pattern: "Enter a value in the format asked for.",
			option: "Choose one of the options.",
			minChoices: "Choose at least {min}.",
			maxChoices: "Choose {max} or fewer.",
		},
	},
	it: {
		send: "Invia",
		sent: "Grazie. Abbiamo ricevuto il tuo messaggio.",
		choose: "Scegli…",
		required: "I campi obbligatori sono segnati con *",
		problemTitle: "C'è un problema",
		errorPrefix: "Errore:",
		honeypot: "Lascia vuoto questo campo",
		captcha: "Completa la verifica prima di inviare.",
		errors: {
			required: "Inserisci un valore.",
			requiredChoice: "Scegli un'opzione.",
			requiredConsent: "Spunta questa casella per continuare.",
			email: "Inserisci un indirizzo email, come nome@esempio.it.",
			phone: "Inserisci un numero di telefono, come +39 06 1234 5678.",
			url: "Inserisci un indirizzo web che inizi con https://.",
			number: "Inserisci un numero.",
			integer: "Inserisci un numero intero.",
			min: "Inserisci {min} o più.",
			max: "Inserisci {max} o meno.",
			date: "Inserisci una data, come 2026-03-02.",
			minDate: "Inserisci {min} o una data successiva.",
			maxDate: "Inserisci {max} o una data precedente.",
			minLength: "Inserisci almeno {min} caratteri.",
			maxLength: "Inserisci al massimo {max} caratteri.",
			pattern: "Inserisci un valore nel formato richiesto.",
			option: "Scegli una delle opzioni.",
			minChoices: "Scegline almeno {min}.",
			maxChoices: "Scegline al massimo {max}.",
		},
	},
	fr: {
		send: "Envoyer",
		sent: "Merci. Nous avons bien reçu votre message.",
		choose: "Choisir…",
		required: "Les champs obligatoires sont marqués d'un *",
		problemTitle: "Il y a un problème",
		errorPrefix: "Erreur :",
		honeypot: "Laissez ce champ vide",
		captcha: "Effectuez la vérification avant d'envoyer.",
		errors: {
			required: "Saisissez une valeur.",
			requiredChoice: "Choisissez une option.",
			requiredConsent: "Cochez cette case pour continuer.",
			email: "Saisissez une adresse e-mail, comme nom@exemple.fr.",
			phone: "Saisissez un numéro de téléphone, comme +33 1 23 45 67 89.",
			url: "Saisissez une adresse web commençant par https://.",
			number: "Saisissez un nombre.",
			integer: "Saisissez un nombre entier.",
			min: "Saisissez {min} ou plus.",
			max: "Saisissez {max} ou moins.",
			date: "Saisissez une date, comme 2026-03-02.",
			minDate: "Saisissez le {min} ou une date ultérieure.",
			maxDate: "Saisissez le {max} ou une date antérieure.",
			minLength: "Saisissez au moins {min} caractères.",
			maxLength: "Saisissez {max} caractères au plus.",
			pattern: "Saisissez une valeur au format demandé.",
			option: "Choisissez l'une des options.",
			minChoices: "Choisissez-en au moins {min}.",
			maxChoices: "Choisissez-en {max} au plus.",
		},
	},
	de: {
		send: "Senden",
		sent: "Vielen Dank. Wir haben Ihre Nachricht erhalten.",
		choose: "Auswählen…",
		required: "Pflichtfelder sind mit * markiert",
		problemTitle: "Es gibt ein Problem",
		errorPrefix: "Fehler:",
		honeypot: "Dieses Feld leer lassen",
		captcha: "Schließen Sie die Prüfung vor dem Senden ab.",
		errors: {
			required: "Geben Sie einen Wert ein.",
			requiredChoice: "Wählen Sie eine Option.",
			requiredConsent: "Kreuzen Sie dieses Feld an, um fortzufahren.",
			email: "Geben Sie eine E-Mail-Adresse ein, z. B. name@beispiel.de.",
			phone: "Geben Sie eine Telefonnummer ein, z. B. +49 30 1234567.",
			url: "Geben Sie eine Webadresse ein, die mit https:// beginnt.",
			number: "Geben Sie eine Zahl ein.",
			integer: "Geben Sie eine ganze Zahl ein.",
			min: "Geben Sie {min} oder mehr ein.",
			max: "Geben Sie {max} oder weniger ein.",
			date: "Geben Sie ein Datum ein, z. B. 2026-03-02.",
			minDate: "Geben Sie den {min} oder später ein.",
			maxDate: "Geben Sie den {max} oder früher ein.",
			minLength: "Geben Sie mindestens {min} Zeichen ein.",
			maxLength: "Geben Sie höchstens {max} Zeichen ein.",
			pattern: "Geben Sie einen Wert im verlangten Format ein.",
			option: "Wählen Sie eine der Optionen.",
			minChoices: "Wählen Sie mindestens {min}.",
			maxChoices: "Wählen Sie höchstens {max}.",
		},
	},
	es: {
		send: "Enviar",
		sent: "Gracias. Hemos recibido tu mensaje.",
		choose: "Elegir…",
		required: "Los campos obligatorios están marcados con *",
		problemTitle: "Hay un problema",
		errorPrefix: "Error:",
		honeypot: "Deja este campo vacío",
		captcha: "Completa la verificación antes de enviar.",
		errors: {
			required: "Introduce un valor.",
			requiredChoice: "Elige una opción.",
			requiredConsent: "Marca esta casilla para continuar.",
			email: "Introduce una dirección de correo, como nombre@ejemplo.es.",
			phone: "Introduce un número de teléfono, como +34 912 345 678.",
			url: "Introduce una dirección web que empiece por https://.",
			number: "Introduce un número.",
			integer: "Introduce un número entero.",
			min: "Introduce {min} o más.",
			max: "Introduce {max} o menos.",
			date: "Introduce una fecha, como 2026-03-02.",
			minDate: "Introduce el {min} o una fecha posterior.",
			maxDate: "Introduce el {max} o una fecha anterior.",
			minLength: "Introduce al menos {min} caracteres.",
			maxLength: "Introduce {max} caracteres como máximo.",
			pattern: "Introduce un valor con el formato pedido.",
			option: "Elige una de las opciones.",
			minChoices: "Elige al menos {min}.",
			maxChoices: "Elige {max} como máximo.",
		},
	},
	pt: {
		send: "Enviar",
		sent: "Obrigado. Recebemos a sua mensagem.",
		choose: "Escolher…",
		required: "Os campos obrigatórios estão marcados com *",
		problemTitle: "Há um problema",
		errorPrefix: "Erro:",
		honeypot: "Deixe este campo vazio",
		captcha: "Conclua a verificação antes de enviar.",
		errors: {
			required: "Introduza um valor.",
			requiredChoice: "Escolha uma opção.",
			requiredConsent: "Marque esta caixa para continuar.",
			email: "Introduza um endereço de email, como nome@exemplo.pt.",
			phone: "Introduza um número de telefone, como +351 21 123 4567.",
			url: "Introduza um endereço web que comece por https://.",
			number: "Introduza um número.",
			integer: "Introduza um número inteiro.",
			min: "Introduza {min} ou mais.",
			max: "Introduza {max} ou menos.",
			date: "Introduza uma data, como 2026-03-02.",
			minDate: "Introduza {min} ou uma data posterior.",
			maxDate: "Introduza {max} ou uma data anterior.",
			minLength: "Introduza pelo menos {min} caracteres.",
			maxLength: "Introduza no máximo {max} caracteres.",
			pattern: "Introduza um valor no formato pedido.",
			option: "Escolha uma das opções.",
			minChoices: "Escolha pelo menos {min}.",
			maxChoices: "Escolha no máximo {max}.",
		},
	},
	nl: {
		send: "Versturen",
		sent: "Dank je. We hebben je bericht ontvangen.",
		choose: "Kies…",
		required: "Verplichte velden zijn gemarkeerd met *",
		problemTitle: "Er is een probleem",
		errorPrefix: "Fout:",
		honeypot: "Laat dit veld leeg",
		captcha: "Voltooi de controle voordat je verstuurt.",
		errors: {
			required: "Vul een waarde in.",
			requiredChoice: "Kies een optie.",
			requiredConsent: "Vink dit vakje aan om door te gaan.",
			email: "Vul een e-mailadres in, zoals naam@voorbeeld.nl.",
			phone: "Vul een telefoonnummer in, zoals +31 20 123 4567.",
			url: "Vul een webadres in dat begint met https://.",
			number: "Vul een getal in.",
			integer: "Vul een geheel getal in.",
			min: "Vul {min} of meer in.",
			max: "Vul {max} of minder in.",
			date: "Vul een datum in, zoals 2026-03-02.",
			minDate: "Vul {min} of later in.",
			maxDate: "Vul {max} of eerder in.",
			minLength: "Vul minstens {min} tekens in.",
			maxLength: "Vul hoogstens {max} tekens in.",
			pattern: "Vul een waarde in de gevraagde vorm in.",
			option: "Kies een van de opties.",
			minChoices: "Kies er minstens {min}.",
			maxChoices: "Kies er hoogstens {max}.",
		},
	},
};

/** The words Forms show in `language`, by its primary subtag: English for a language WebCraft has no words in. */
export function formWords(language: string | undefined): FormWords {
	const primary = (language ?? "en").split("-")[0]?.toLowerCase() ?? "en";
	return WORDS[primary] ?? (WORDS.en as FormWords);
}

/** A rule's words with `{min}`, `{max}` and `{count}` filled in. */
export function ruleMessage(words: FormWords, rule: FormRule, params: Readonly<Record<string, string | number>> = {}) {
	return words.errors[rule].replace(/\{(min|max|count)\}/g, (_, name: string) => String(params[name] ?? ""));
}
