import {
	AtSignIcon,
	CalendarIcon,
	CircleDotIcon,
	EyeOffIcon,
	FootprintsIcon,
	GroupIcon,
	HashIcon,
	LinkIcon,
	ListChecksIcon,
	type LucideIcon,
	PaperclipIcon,
	PhoneIcon,
	SquareCheckIcon,
	SquareChevronDownIcon,
	TextIcon,
	TypeIcon,
} from "lucide-react";

import type { FormFieldType } from "./model.ts";

/**
 * The icon of each type of field, wherever a Form's fields are built: the admin's Build tab (its
 * palette and list) and the building area's Forms place (its kinds' cards and the canvas).
 */
export const FIELD_ICONS: Record<FormFieldType, LucideIcon> = {
	text: TypeIcon,
	email: AtSignIcon,
	phone: PhoneIcon,
	url: LinkIcon,
	textarea: TextIcon,
	number: HashIcon,
	date: CalendarIcon,
	select: SquareChevronDownIcon,
	radio: CircleDotIcon,
	checkboxes: ListChecksIcon,
	consent: SquareCheckIcon,
	hidden: EyeOffIcon,
	file: PaperclipIcon,
	section: GroupIcon,
	step: FootprintsIcon,
};
