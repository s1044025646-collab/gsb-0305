declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(location: string, options?: { open?: boolean });
    open?(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    transaction<T extends (...args: never[]) => unknown>(fn: T): T;
    close(): void;
  }
  export interface StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    setAllowBareNamedParameters?(allowed: boolean): void;
  }
}
