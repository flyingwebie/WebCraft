import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Your account and its pages (API tokens). */
export const Route = createFileRoute("/_admin/account")({
	staticData: { crumb: "account.pageTitle" },
	component: Outlet,
});
