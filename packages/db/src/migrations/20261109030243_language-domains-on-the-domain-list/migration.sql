-- Language domains (site_languages.domain, from the languages work) join the Site's domain list, so
-- they are verified and checked like every other domain. They start waiting for DNS: Staff press
-- Check now on the Domains screen to verify them.
INSERT INTO "site_domains" ("workspace_id", "site_id", "name", "role", "language", "created_at")
SELECT l."workspace_id", l."site_id", l."domain", 'language', l."code", now()
FROM "site_languages" l
WHERE l."domain" IS NOT NULL
ON CONFLICT DO NOTHING;
