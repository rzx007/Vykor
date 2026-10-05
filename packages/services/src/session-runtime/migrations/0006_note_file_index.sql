CREATE TABLE `note_file_index` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`sha256` text NOT NULL,
	`deleted_at` integer
);
