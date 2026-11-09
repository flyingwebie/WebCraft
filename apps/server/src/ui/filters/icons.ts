import type { FilterControlType } from "@webcraft/renderer/filters";
import {
	ArrowDownUpIcon,
	CircleDotIcon,
	CircleXIcon,
	HashIcon,
	ListChecksIcon,
	type LucideIcon,
	MoveHorizontalIcon,
	SearchIcon,
	ToggleRightIcon,
} from "lucide-react";

/** The icon of each kind of Filter control, in the Add menu and the control list. */
export const CONTROL_ICONS: Record<FilterControlType, LucideIcon> = {
	search: SearchIcon,
	checkboxes: ListChecksIcon,
	choice: CircleDotIcon,
	toggle: ToggleRightIcon,
	range: MoveHorizontalIcon,
	sort: ArrowDownUpIcon,
	chips: CircleXIcon,
	count: HashIcon,
};
