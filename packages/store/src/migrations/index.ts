import { sql as init } from "./0001_init.js";
import { sql as runLocks } from "./0002_run_locks.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** All migrations, in order. Append new ones; never edit or reorder released ones. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "init", sql: init },
  { version: 2, name: "run_locks", sql: runLocks },
];
