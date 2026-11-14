import {
	AlignLeftIcon,
	AtSignIcon,
	CalendarIcon,
	FileTextIcon,
	FolderIcon,
	HashIcon,
	ImageIcon,
	Link2Icon,
	LinkIcon,
	ListIcon,
	RepeatIcon,
	ToggleLeftIcon,
	TypeIcon,
} from "lucide-react";

import type { Icon } from "../../../controls.tsx";
import type { FieldType } from "./fields.ts";

/** Each Field kind's icon in the list and the details panel (`places-content/03`). */
export const KIND_ICONS: { readonly [Type in FieldType]: Icon } = {
	text: TypeIcon,
	richText: AlignLeftIcon,
	body: FileTextIcon,
	number: HashIcon,
	boolean: ToggleLeftIcon,
	date: CalendarIcon,
	select: ListIcon,
	media: ImageIcon,
	link: LinkIcon,
	email: AtSignIcon,
	relationship: Link2Icon,
	group: FolderIcon,
	repeater: RepeatIcon,
};
