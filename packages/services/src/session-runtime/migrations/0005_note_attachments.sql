CREATE TABLE `note_attachment` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`name` text NOT NULL,
	`media_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`data` blob NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `note`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `note_attachment_note_idx` ON `note_attachment` (`note_id`);