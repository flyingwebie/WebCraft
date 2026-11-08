import { cn } from "@webcraft/ui/lib/utils.ts";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
	return <div data-slot="skeleton" className={cn("bg-muted animate-pulse rounded-none", className)} {...props} />;
}

export { Skeleton };
