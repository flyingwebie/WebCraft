import type { Words } from "../../../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../../../controls.tsx";
import { AddIcon, Badge, PlaceIconButton } from "../ui.tsx";

/**
 * The Content place's "Post Types" group in its sidebar, for Staff (`places-content/02`): its title,
 * which opens the Post Types list (drawn raised while it is open), the Staff badge, and "+", which
 * opens the list with the create row's name focused.
 */
export function PostTypesGroup({
	words,
	current,
	onOpen,
	onNew,
}: {
	words: Words;
	current: boolean;
	onOpen(): void;
	onNew(): void;
}) {
	const shown = words.content;
	return (
		<div
			className={`flex h-8 items-center gap-2 rounded-md pe-1 ${current ? "bg-chrome-raised" : ""} ${CHROME_EASE}`}
			data-wc-post-types-group=""
		>
			<button
				type="button"
				onClick={onOpen}
				aria-current={current ? "page" : undefined}
				className={`text-chrome-strong hover:text-chrome-strong flex h-8 min-w-0 items-center rounded-md px-2 text-start text-[12px] font-semibold hover:underline ${FOCUS_RING}`}
				data-wc-content-row="post-types"
			>
				{shown.postTypes}
			</button>
			<Badge kind="neutral">{shown.staffOnly}</Badge>
			<span className="ms-auto inline-flex">
				<PlaceIconButton
					icon={AddIcon}
					label={shown.newPostType}
					onClick={onNew}
					data={{ "data-wc-new-post-type": "" }}
				/>
			</span>
		</div>
	);
}
