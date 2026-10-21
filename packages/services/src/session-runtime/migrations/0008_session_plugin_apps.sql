CREATE TABLE `session_plugin_app` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`plugin_version` text NOT NULL,
	`plugin_digest` text NOT NULL,
	`definition_digest` text NOT NULL,
	`backend_id` text NOT NULL,
	`backend_kind` text NOT NULL,
	`resource_uri` text NOT NULL,
	`origin_json` text NOT NULL,
	`logical_key` text NOT NULL,
	`status` text NOT NULL,
	`control_revision` integer NOT NULL,
	`active_action_run_id` text,
	`last_action_run_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "session_plugin_app_status" CHECK("session_plugin_app"."status" IN ('open', 'closed', 'revoked')),
	CONSTRAINT "session_plugin_app_backend_kind" CHECK("session_plugin_app"."backend_kind" IN ('native-tools', 'mcp-server')),
	CONSTRAINT "session_plugin_app_revision" CHECK("session_plugin_app"."control_revision" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_plugin_app_logical_key` ON `session_plugin_app` (`session_id`,`logical_key`);--> statement-breakpoint
CREATE INDEX `session_plugin_app_session_status_idx` ON `session_plugin_app` (`session_id`,`status`);