CREATE TABLE `execution` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`data_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `execution_run_idx` ON `execution` (`run_id`);--> statement-breakpoint
CREATE INDEX `execution_session_idx` ON `execution` (`session_id`);--> statement-breakpoint
CREATE TABLE `tool_dispatch_attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`data_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tool_dispatch_attempt_operation_idx` ON `tool_dispatch_attempt` (`operation_id`);--> statement-breakpoint
CREATE INDEX `tool_dispatch_attempt_session_idx` ON `tool_dispatch_attempt` (`session_id`);--> statement-breakpoint
CREATE TABLE `tool_operation` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`logical_call_id` text NOT NULL,
	`state` text NOT NULL,
	`data_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_operation_call_idx` ON `tool_operation` (`session_id`,`run_id`,`logical_call_id`);--> statement-breakpoint
CREATE INDEX `tool_operation_session_state_idx` ON `tool_operation` (`session_id`,`state`);