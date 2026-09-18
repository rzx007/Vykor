CREATE TABLE `application_owner` (
	`key` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`pid` integer NOT NULL,
	`generation` integer NOT NULL,
	`started_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `application_storage_format` (
	`id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	CONSTRAINT "application_storage_format_singleton" CHECK("application_storage_format"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `attachment_asset` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`declared_media_type` text,
	`media_type` text,
	`size_bytes` integer,
	`sha256` text,
	`status` text NOT NULL,
	`staging_name` text,
	`failure_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `attachment_asset_hash_status_idx` ON `attachment_asset` (`sha256`,`status`);--> statement-breakpoint
CREATE INDEX `attachment_asset_status_updated_idx` ON `attachment_asset` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `attachment_lease` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`renewed_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `attachment_asset`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachment_lease_asset_owner_unique` ON `attachment_lease` (`asset_id`,`owner_kind`,`owner_id`);--> statement-breakpoint
CREATE INDEX `attachment_lease_expiry_idx` ON `attachment_lease` (`expires_at`,`asset_id`);--> statement-breakpoint
CREATE TABLE `attachment_representation` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`processor` text NOT NULL,
	`processor_version` text NOT NULL,
	`cache_key` text NOT NULL,
	`media_type` text NOT NULL,
	`text` text,
	`error` text,
	`metadata_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `attachment_asset`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachment_representation_asset_kind_cache_unique` ON `attachment_representation` (`asset_id`,`kind`,`cache_key`);--> statement-breakpoint
CREATE INDEX `attachment_representation_asset_idx` ON `attachment_representation` (`asset_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `channel_delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`connector` text NOT NULL,
	`account_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`thread_id` text DEFAULT '' NOT NULL,
	`session_id` text NOT NULL,
	`input_id` text NOT NULL,
	`run_id` text NOT NULL,
	`external_message_id` text NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`external_delivery_id` text,
	`platform_meta_json` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `external_conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`input_id`) REFERENCES `session_input`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `session_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_delivery_input_unique` ON `channel_delivery` (`input_id`);--> statement-breakpoint
CREATE INDEX `channel_delivery_status_idx` ON `channel_delivery` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `external_conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`connector` text NOT NULL,
	`account_id` text NOT NULL,
	`workspace_id` text,
	`chat_id` text NOT NULL,
	`thread_id` text DEFAULT '' NOT NULL,
	`session_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_conversation_identity_unique` ON `external_conversation` (`connector`,`account_id`,`chat_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `external_conversation_session_idx` ON `external_conversation` (`session_id`);--> statement-breakpoint
CREATE TABLE `permission_request` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`run_id` text,
	`tool_name` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`decision` text,
	`decided_by_client_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `permission_session_status_idx` ON `permission_request` (`session_id`,`status`);--> statement-breakpoint
CREATE TABLE `project_location` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`normalized_path` text NOT NULL,
	`status` text NOT NULL,
	`bound_at` integer NOT NULL,
	`last_verified_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_location_project_idx` ON `project_location` (`project_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_location_active_path` ON `project_location` (`normalized_path`) WHERE "project_location"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `project_location_active_project` ON `project_location` (`project_id`) WHERE "project_location"."status" = 'active';--> statement-breakpoint
CREATE TABLE `projection_settlement` (
	`id` text PRIMARY KEY NOT NULL,
	`projector` text NOT NULL,
	`root_session_id` text NOT NULL,
	`event_sequence` integer NOT NULL,
	`action` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_retry_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projection_settlement_event_idx` ON `projection_settlement` (`projector`,`root_session_id`,`event_sequence`);--> statement-breakpoint
CREATE INDEX `projection_settlement_status_retry_idx` ON `projection_settlement` (`status`,`next_retry_at`);--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`pinned_at` integer,
	`default_shell` text,
	`last_opened_at` integer NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `retention_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`policy` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scheduled_run` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`cause` text NOT NULL,
	`status` text NOT NULL,
	`scheduled_for` integer NOT NULL,
	`session_id` text,
	`run_id` text,
	`summary` text,
	`error` text,
	`unread` integer NOT NULL,
	`attention_reason` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scheduled_run_task_created_idx` ON `scheduled_run` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `scheduled_run_status_idx` ON `scheduled_run` (`status`);--> statement-breakpoint
CREATE INDEX `scheduled_run_unread_idx` ON `scheduled_run` (`unread`,`created_at`);--> statement-breakpoint
CREATE TABLE `scheduled_task` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`prompt` text NOT NULL,
	`recurrence` text NOT NULL,
	`recurrence_format` text NOT NULL,
	`timezone` text NOT NULL,
	`status` text NOT NULL,
	`destination` text NOT NULL,
	`session_id` text,
	`project_paths_json` text NOT NULL,
	`execution_mode` text NOT NULL,
	`model` text,
	`effort` text,
	`skill_names_json` text NOT NULL,
	`plugin_names_json` text NOT NULL,
	`permission_profile_json` text NOT NULL,
	`overlap_policy` text NOT NULL,
	`missed_run_policy` text NOT NULL,
	`stop_policy_json` text,
	`created_by` text NOT NULL,
	`created_from_session_id` text,
	`last_run_at` integer,
	`next_run_at` integer,
	`run_count` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scheduled_task_status_next_idx` ON `scheduled_task` (`status`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `scheduled_task_session_idx` ON `scheduled_task` (`session_id`);--> statement-breakpoint
CREATE TABLE `session_event_sequence` (
	`id` integer PRIMARY KEY,
	`reserved_through` integer NOT NULL,
	CONSTRAINT "session_event_sequence_singleton" CHECK("session_event_sequence"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `session_event` (
	`id` text PRIMARY KEY,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`session_id` text,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_event_seq_unique` ON `session_event` (`seq`);--> statement-breakpoint
CREATE INDEX `session_event_session_seq_idx` ON `session_event` (`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `session_goal_assessment` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`revision` integer NOT NULL,
	`run_id` text NOT NULL,
	`assessment_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `session_goal`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_goal_assessment_run_unique` ON `session_goal_assessment` (`goal_id`,`revision`,`run_id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `session_goal_continuation_previous_unique` ON `session_goal_continuation` (`goal_id`,`revision`,`previous_run_id`);--> statement-breakpoint
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
CREATE INDEX `session_goal_request_session_idx` ON `session_goal_request` (`session_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `session_goal` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`objective` text NOT NULL,
	`plugin_id` text,
	`revision` integer NOT NULL,
	`status` text NOT NULL,
	`max_auto_turns` integer NOT NULL,
	`auto_turns_used` integer NOT NULL,
	`no_progress_count` integer NOT NULL,
	`blocker_key` text,
	`last_assessment_json` text,
	`current_run_id` text,
	`reason` text,
	`wait_json` text,
	`evidence_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_goal_session_updated_idx` ON `session_goal` (`session_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_goal_session_open_unique` ON `session_goal` (`session_id`) WHERE "session_goal"."status" IN ('active','waiting_user','blocked','paused');--> statement-breakpoint
CREATE TABLE `session_input_attachment` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`input_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`seq` integer NOT NULL,
	`intent` text NOT NULL,
	`display_name` text NOT NULL,
	`media_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`metadata_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`input_id`) REFERENCES `session_input`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `attachment_asset`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `session_input_attachment_input_seq_idx` ON `session_input_attachment` (`input_id`,`seq`);--> statement-breakpoint
CREATE INDEX `session_input_attachment_asset_idx` ON `session_input_attachment` (`asset_id`);--> statement-breakpoint
CREATE INDEX `session_input_attachment_session_idx` ON `session_input_attachment` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_input_attachment_input_seq_unique` ON `session_input_attachment` (`input_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_input_attachment_input_asset_unique` ON `session_input_attachment` (`input_id`,`asset_id`);--> statement-breakpoint
CREATE TABLE `session_input` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`delivery` text NOT NULL,
	`content` text NOT NULL,
	`items_json` text NOT NULL,
	`metadata_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_input_session_idx` ON `session_input` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_input_session_seq` ON `session_input` (`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `session_message_part` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`text` text,
	`tool_use_id` text,
	`tool_name` text,
	`input_json` text,
	`output_json` text,
	`is_error` integer,
	`asset_id` text,
	`attachment_intent` text,
	`display_name` text,
	`media_type` text,
	`size_bytes` integer,
	`transformation_kind` text,
	`representation_id` text,
	`processor` text,
	`transformation_error` text,
	`metadata_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_part_message_idx` ON `session_message_part` (`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_part_session_seq` ON `session_message_part` (`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `session_message` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`run_id` text,
	`input_id` text,
	`metadata_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_message_session_idx` ON `session_message` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_message_session_seq` ON `session_message` (`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `session_run_attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`status` text NOT NULL,
	`provider` text,
	`model` text,
	`retry_reason` text,
	`error_kind` text,
	`error` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_run_attempt_run_sequence_unique` ON `session_run_attempt` (`run_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `session_run_attempt_run_idx` ON `session_run_attempt` (`run_id`);--> statement-breakpoint
CREATE INDEX `session_run_attempt_status_idx` ON `session_run_attempt` (`status`);--> statement-breakpoint
CREATE TABLE `session_run` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`input_id` text,
	`status` text NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`error` text,
	`metadata_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_run_session_idx` ON `session_run` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `session_run_input_idx` ON `session_run` (`input_id`);--> statement-breakpoint
CREATE TABLE `session_task` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`request_namespace` text,
	`request_id` text,
	`child_session_id` text,
	`run_id` text,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`description` text NOT NULL,
	`cwd` text NOT NULL,
	`output` text,
	`error` text,
	`metadata_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `session_task_session_idx` ON `session_task` (`session_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_task_request_identity_idx` ON `session_task` (`session_id`,`request_namespace`,`request_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY,
	`parent_id` text,
	`project_id` text,
	`cwd` text NOT NULL,
	`cwd_relative` text,
	`title` text NOT NULL,
	`model` text NOT NULL,
	`agent` text,
	`status` text NOT NULL,
	`metadata_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `session_parent_idx` ON `session` (`parent_id`);--> statement-breakpoint
CREATE INDEX `session_cwd_updated_idx` ON `session` (`cwd`,`updated_at`);--> statement-breakpoint
CREATE TABLE `workflow_event` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_run_id` text NOT NULL,
	`type` text NOT NULL,
	`event_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_event_run_seq_idx` ON `workflow_event` (`workflow_run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `workflow_execution_claim` (
	`workflow_run_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`generation` integer NOT NULL,
	`claimed_at` integer NOT NULL,
	`heartbeat_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workflow_run` (
	`run_id` text PRIMARY KEY NOT NULL,
	`owner_session_id` text,
	`owner_input_id` text,
	`owner_run_id` text,
	`status` text NOT NULL,
	`termination` text,
	`snapshot_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_input_id`) REFERENCES `session_input`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_run_id`) REFERENCES `session_run`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workflow_run_owner_idx` ON `workflow_run` (`owner_session_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `workflow_run_status_idx` ON `workflow_run` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `workflow_task_attempt` (
	`workflow_run_id` text NOT NULL,
	`task_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`status` text NOT NULL,
	`payload_json` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	PRIMARY KEY(`workflow_run_id`, `task_id`, `attempt`),
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO application_storage_format (id, version) VALUES (1, 3);
--> statement-breakpoint
INSERT INTO session_event_sequence (id, reserved_through) VALUES (1, 0);
