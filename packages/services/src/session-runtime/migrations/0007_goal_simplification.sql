-- Discard only Goal-owned state; sessions, messages, Runs, and tool history remain intact.
DROP TABLE `session_goal_assessment`;
--> statement-breakpoint
DROP TABLE `session_goal_continuation`;
--> statement-breakpoint
DROP TABLE `session_goal_model_attempt`;
--> statement-breakpoint
DROP TABLE `session_goal_version`;
--> statement-breakpoint
DROP TABLE `session_goal_request`;
--> statement-breakpoint
DROP TABLE `session_goal`;
--> statement-breakpoint
CREATE TABLE `session_goal` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`objective` text NOT NULL,
	`objective_version` integer DEFAULT 1 NOT NULL,
	`plugin_id` text,
	`revision` integer NOT NULL,
	`status` text NOT NULL,
	`max_auto_turns` integer NOT NULL,
	`token_budget` integer,
	`usage_json` text NOT NULL,
	`auto_turns_used` integer NOT NULL,
	`current_run_id` text,
	`reason` text,
	`stop_reason_json` text,
	`wait_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_goal_session_updated_idx` ON `session_goal` (`session_id`,`updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_goal_session_open_unique` ON `session_goal` (`session_id`) WHERE "session_goal"."status" IN ('active','waiting_user','blocked','paused');
--> statement-breakpoint
CREATE TABLE `session_goal_version` (
	`goal_id` text NOT NULL,
	`objective_version` integer NOT NULL,
	`previous_version` integer,
	`objective` text NOT NULL,
	`request_id` text NOT NULL,
	`actor_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`goal_id`, `objective_version`),
	FOREIGN KEY (`goal_id`) REFERENCES `session_goal`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session_goal_model_attempt` (
	`run_id` text NOT NULL,
	`generation_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`goal_id` text NOT NULL,
	`objective_version` integer NOT NULL,
	`session_id` text NOT NULL,
	`provider` text,
	`model` text NOT NULL,
	`purpose` text NOT NULL,
	`state` text NOT NULL,
	`known_input_tokens` integer NOT NULL,
	`known_output_tokens` integer NOT NULL,
	`inconsistent` integer NOT NULL,
	`raw_usage_json` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	PRIMARY KEY(`run_id`, `generation_id`, `attempt`),
	FOREIGN KEY (`goal_id`) REFERENCES `session_goal`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_goal_model_attempt_goal_idx` ON `session_goal_model_attempt` (`goal_id`);
--> statement-breakpoint
CREATE TABLE `session_goal_request` (
	`request_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`goal_id` text,
	`result_json` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_goal_request_session_idx` ON `session_goal_request` (`session_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `session_goal_continuation` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`revision` integer NOT NULL,
	`previous_run_id` text NOT NULL,
	`input_id` text,
	`run_id` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `session_goal`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_goal_continuation_previous_unique` ON `session_goal_continuation` (`goal_id`,`revision`,`previous_run_id`);
