// Schema changes specific to the planningFamille fork. Same rules as registry.ts
// (append only, never edit a shipped migration), but kept in our own file and
// our own 'fork/' namespace so upstream merges never touch this list.

import type { Migration } from './runner';

export const forkMigrations: readonly Migration[] = [
    {
        // Homework ("Devoirs") reuses the tasks table: due_date is the hand-in
        // date, completed_at is when it was actually done, and points + the
        // parent approval flow work exactly as for chores. `category` tells the
        // two apart; `subject` is an optional school subject (Maths, Français...).
        id: 'fork/0001-task-homework',
        statements: [
            "ALTER TABLE tasks ADD COLUMN category VARCHAR(20) NOT NULL DEFAULT 'chore'",
            'ALTER TABLE tasks ADD COLUMN subject VARCHAR(50)',
        ],
    },
];
