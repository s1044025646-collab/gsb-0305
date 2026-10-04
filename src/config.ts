import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const MAX_CYLINDERS = 10_000;
export const MAX_REQUESTS = 100_000;
export const MAX_TIME = 1_000_000_000;
export const MAX_STEP_BUDGET = 1_000_000;
export const DEFAULT_STEP_BUDGET = 10_000;

export interface ResolvedPaths {
  dataDir: string;
  dbPath: string;
  exportDir: string;
}

export function resolvePaths(dataDir?: string): ResolvedPaths {
  const base = resolve(dataDir ?? process.env.LOOK_DATA_DIR ?? "data");
  const paths = {
    dataDir: base,
    dbPath: resolve(base, "look.db"),
    exportDir: resolve(base, "exports"),
  };
  mkdirSync(dirname(paths.dbPath), { recursive: true });
  mkdirSync(paths.exportDir, { recursive: true });
  return paths;
}
