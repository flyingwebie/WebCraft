import type { Person } from "@webcraft/core";

/** A person as the API shows them. */
export function personView(person: Person) {
	return {
		id: person.id,
		name: person.name,
		email: person.email,
		installRole: person.installRole,
		adminLanguage: person.adminLanguage,
		adminTheme: person.adminTheme,
	};
}

export type PersonView = ReturnType<typeof personView>;
