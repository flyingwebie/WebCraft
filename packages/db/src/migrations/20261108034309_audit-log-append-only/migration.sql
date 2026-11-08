-- The Audit log is append-only: entries are inserted and never changed. Deleting old entries stays
-- possible, for the retention setting (entries are kept 1 year by default).
CREATE FUNCTION audit_log_refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'Audit log entries can''t be changed.';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION audit_log_refuse_change();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON "audit_log" FOR EACH STATEMENT EXECUTE FUNCTION audit_log_refuse_change();
