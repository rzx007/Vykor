CREATE TABLE `tool_result` (
 `id` text PRIMARY KEY NOT NULL, `session_id` text NOT NULL, `run_id` text NOT NULL,
 `tool_use_id` text NOT NULL, `tool_name` text NOT NULL, `source_kind` text NOT NULL,
 `source_id` text, `text` text NOT NULL, `total_chars` integer NOT NULL, `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tool_result_session_idx` ON `tool_result` (`session_id`);
--> statement-breakpoint
DROP TABLE `tool_dispatch_attempt`;
--> statement-breakpoint
DROP TABLE `tool_operation`;
--> statement-breakpoint
DROP TABLE `execution`;
