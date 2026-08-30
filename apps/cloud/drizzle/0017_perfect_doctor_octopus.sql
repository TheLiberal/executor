CREATE TABLE "connection_access_group" (
	"integration" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"group_id" varchar(255) NOT NULL,
	"created_at" timestamp NOT NULL,
	"row_id" varchar(255) PRIMARY KEY NOT NULL,
	"tenant" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "connection_access_group_uidx" ON "connection_access_group" USING btree ("tenant","integration","name","group_id");--> statement-breakpoint
-- Backfill: every legacy single-valued `connection.access_group` restriction
-- on an org-owned connection becomes exactly one grant row in the new
-- multi-group table (OR semantics). The legacy column is kept (the core
-- schema still declares it so SQLite hosts, which cannot drop columns, stay
-- physically identical) but is no longer read or written.
INSERT INTO "connection_access_group" ("row_id", "tenant", "integration", "name", "group_id", "created_at")
SELECT
	'cag_' || replace(gen_random_uuid()::text, '-', ''),
	c."tenant", c."integration", c."name", c."access_group", c."updated_at"
FROM "connection" AS c
WHERE c."access_group" IS NOT NULL
	AND c."owner" = 'org'
	AND NOT EXISTS (
		SELECT 1 FROM "connection_access_group" AS g
		WHERE g."tenant" = c."tenant" AND g."integration" = c."integration"
			AND g."name" = c."name" AND g."group_id" = c."access_group"
	);
