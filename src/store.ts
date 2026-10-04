import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolvePaths } from "./config.js";
import { SimError } from "./errors.js";
import type {
  Direction,
  RequestInput,
  RunState,
  RunStatus,
  SimEvent,
  ServedRequest,
  VersionSnapshot,
} from "./types.js";

interface ModelRow {
  id: number;
  name: string;
  created_at: string;
}

interface VersionRow {
  id: number;
  model_id: number;
  version: number;
  max_cylinder: number;
  initial_head: number;
  initial_direction: number;
  started: number;
  created_at: string;
}

interface RunRow {
  id: number;
  version_id: number;
  time: number;
  head: number;
  direction: number;
  distance: number;
  reversals: number;
  status: RunStatus;
  pending_ids: string;
  served: string;
  next_arrival_index: number;
}

export class Store {
  readonly db: DatabaseSync;
  readonly exportDir: string;

  constructor(dataDir?: string) {
    const paths = resolvePaths(dataDir);
    this.db = new DatabaseSync(paths.dbPath);
    this.exportDir = paths.exportDir;
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  /** 在单个 SQLite 事务内执行，异常自动回滚，保证状态与事件原子落盘。 */
  withTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrate(): void {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id INTEGER NOT NULL REFERENCES models(id),
        version INTEGER NOT NULL,
        max_cylinder INTEGER NOT NULL,
        initial_head INTEGER NOT NULL,
        initial_direction INTEGER NOT NULL,
        started INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(model_id, version)
      );
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL REFERENCES versions(id),
        req_id TEXT NOT NULL,
        arrival INTEGER NOT NULL,
        cylinder INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        UNIQUE(version_id, req_id)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL UNIQUE REFERENCES versions(id),
        time INTEGER NOT NULL,
        head INTEGER NOT NULL,
        direction INTEGER NOT NULL,
        distance INTEGER NOT NULL,
        reversals INTEGER NOT NULL,
        status TEXT NOT NULL,
        pending_ids TEXT NOT NULL,
        served TEXT NOT NULL,
        next_arrival_index INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER NOT NULL,
        run_id INTEGER NOT NULL REFERENCES runs(id),
        time INTEGER NOT NULL,
        type TEXT NOT NULL,
        head INTEGER NOT NULL,
        direction INTEGER NOT NULL,
        detail TEXT NOT NULL,
        request_ids TEXT,
        queue_ids TEXT,
        next_head INTEGER,
        reversed INTEGER,
        distance_delta INTEGER,
        PRIMARY KEY (run_id, seq)
      );
    `);
  }

  createModel(name: string): ModelRow {
    const info = this.db.prepare("INSERT INTO models(name) VALUES (?)").run(name);
    return this.getModel(Number(info.lastInsertRowid))!;
  }

  getModel(id: number): ModelRow | undefined {
    return this.db.prepare("SELECT * FROM models WHERE id = ?").get(id) as ModelRow | undefined;
  }

  listModels(): ModelRow[] {
    return this.db.prepare("SELECT * FROM models ORDER BY id").all() as unknown as ModelRow[];
  }

  createVersion(
    modelId: number,
    maxCylinder: number,
    initialHead: number,
    initialDirection: Direction,
    requests: RequestInput[],
  ): VersionSnapshot {
    const tx = this.db.prepare(
      "INSERT INTO versions(model_id, version, max_cylinder, initial_head, initial_direction) VALUES (?,?,?,?,?)",
    );
    const insReq = this.db.prepare(
      "INSERT INTO requests(version_id, req_id, arrival, cylinder, seq) VALUES (?,?,?,?,?)",
    );
    const row = this.withTransaction((): VersionRow => {
      if (!this.getModel(modelId)) {
        throw new SimError("NOT_FOUND", `模型 ${modelId} 不存在`);
      }
      const maxVer = this.db
        .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM versions WHERE model_id = ?")
        .get(modelId) as { v: number };
      const version = maxVer.v + 1;
      const info = tx.run(modelId, version, maxCylinder, initialHead, initialDirection);
      const versionId = Number(info.lastInsertRowid);
      requests.forEach((r, index) =>
        insReq.run(versionId, r.id, r.arrival, r.cylinder, index),
      );
      return this.db.prepare("SELECT * FROM versions WHERE id = ?").get(versionId) as unknown as VersionRow;
    });
    return this.toVersionSnapshot(row);
  }

  listVersions(modelId: number): VersionRow[] {
    return this.db
      .prepare("SELECT * FROM versions WHERE model_id = ? ORDER BY version")
      .all(modelId) as unknown as VersionRow[];
  }

  getVersion(versionId: number): VersionSnapshot | undefined {
    const row = this.db.prepare("SELECT * FROM versions WHERE id = ?").get(versionId) as
      | VersionRow
      | undefined;
    return row ? this.toVersionSnapshot(row) : undefined;
  }

  /** 已经开始的到达表不可原地修改；换请求集请创建新版本。 */
  assertVersionNotStarted(versionId: number): void {
    const row = this.db.prepare("SELECT started FROM versions WHERE id = ?").get(versionId) as
      | { started: number }
      | undefined;
    if (!row) throw new SimError("NOT_FOUND", `请求版本 ${versionId} 不存在`);
    if (row.started) {
      throw new SimError(
        "CONFLICT",
        `版本 ${versionId} 已开始运行，到达表不可修改；请为该模型创建新版本`,
      );
    }
  }

  private toVersionSnapshot(row: VersionRow): VersionSnapshot {
    const requests = this.db
      .prepare("SELECT req_id, arrival, cylinder FROM requests WHERE version_id = ? ORDER BY seq")
      .all(row.id) as { req_id: string; arrival: number; cylinder: number }[];
    return {
      id: row.id,
      modelId: row.model_id,
      version: row.version,
      maxCylinder: row.max_cylinder,
      initialHead: row.initial_head,
      initialDirection: row.initial_direction as Direction,
      started: row.started === 1,
      createdAt: row.created_at,
      requests: requests.map((r) => ({
        id: r.req_id,
        arrival: r.arrival,
        cylinder: r.cylinder,
      })),
    };
  }

  getRunByVersion(versionId: number): RunState | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE version_id = ?").get(versionId) as
      | RunRow
      | undefined;
    return row ? this.toRunState(row) : undefined;
  }

  getRun(runId: number): RunState | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as
      | RunRow
      | undefined;
    return row ? this.toRunState(row) : undefined;
  }

  listRuns(modelId: number): RunState[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM runs r JOIN versions v ON r.version_id = v.id
         WHERE v.model_id = ? ORDER BY r.id`,
      )
      .all(modelId) as unknown as RunRow[];
    return rows.map((row) => this.toRunState(row));
  }

  private toRunState(row: RunRow): RunState {
    return {
      runId: row.id,
      versionId: row.version_id,
      time: row.time,
      head: row.head,
      direction: row.direction as Direction,
      distance: row.distance,
      reversals: row.reversals,
      status: row.status,
      pendingIds: JSON.parse(row.pending_ids) as string[],
      served: JSON.parse(row.served) as ServedRequest[],
      nextArrivalIndex: row.next_arrival_index,
    };
  }

  /**
   * 原子持久化：运行状态（含方向、位置、待处理项）与本批事件在同一事务内写入，
   * 保证进程在任何时刻崩溃都不会出现“事件已写、状态未更新”的撕裂。
   */
  saveProgress(state: RunState, events: SimEvent[], markStarted: boolean): void {
    const upsert = this.db.prepare(`
      INSERT INTO runs(id, version_id, time, head, direction, distance, reversals, status, pending_ids, served, next_arrival_index, updated_at)
      VALUES (NULL, @versionId, @time, @head, @direction, @distance, @reversals, @status, @pendingIds, @served, @nextIndex, datetime('now'))
      ON CONFLICT(version_id) DO UPDATE SET
        time=@time, head=@head, direction=@direction, distance=@distance, reversals=@reversals,
        status=@status, pending_ids=@pendingIds, served=@served, next_arrival_index=@nextIndex, updated_at=datetime('now')
    `);
    const insEvent = this.db.prepare(`
      INSERT INTO events(seq, run_id, time, type, head, direction, detail, request_ids, queue_ids, next_head, reversed, distance_delta)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    this.withTransaction(() => {
      upsert.run({
        versionId: state.versionId,
        time: state.time,
        head: state.head,
        direction: state.direction,
        distance: state.distance,
        reversals: state.reversals,
        status: state.status,
        pendingIds: JSON.stringify(state.pendingIds),
        served: JSON.stringify(state.served),
        nextIndex: state.nextArrivalIndex,
      });
      const runRow = this.db
        .prepare("SELECT id FROM runs WHERE version_id = ?")
        .get(state.versionId) as { id: number };
      state.runId = runRow.id;
      for (const e of events) {
        insEvent.run(
          e.seq,
          runRow.id,
          e.time,
          e.type,
          e.head,
          e.direction,
          e.detail,
          e.requestIds ? JSON.stringify(e.requestIds) : null,
          e.queueIds ? JSON.stringify(e.queueIds) : null,
          e.nextHead ?? null,
          e.reversed === undefined ? null : e.reversed ? 1 : 0,
          e.distanceDelta ?? null,
        );
      }
      if (markStarted) {
        this.db.prepare("UPDATE versions SET started = 1 WHERE id = ?").run(state.versionId);
      }
    });
  }

  listEvents(runId: number): SimEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE run_id = ? ORDER BY seq")
      .all(runId) as Record<string, unknown>[];
    return rows.map((row) => this.toEvent(row));
  }

  private toEvent(row: Record<string, unknown>): SimEvent {
    return {
      seq: Number(row.seq),
      time: Number(row.time),
      type: row.type as SimEvent["type"],
      head: Number(row.head),
      direction: Number(row.direction) as Direction,
      detail: String(row.detail),
      requestIds: row.request_ids ? (JSON.parse(String(row.request_ids)) as string[]) : undefined,
      queueIds: row.queue_ids ? (JSON.parse(String(row.queue_ids)) as string[]) : undefined,
      nextHead: row.next_head === null ? undefined : Number(row.next_head),
      reversed: row.reversed === null ? undefined : row.reversed === 1,
      distanceDelta: row.distance_delta === null ? undefined : Number(row.distance_delta),
    };
  }

  writeJsonExport(versionId: number, payload: unknown): string {
    const file = resolve(this.exportDir, `version_${versionId}_export.json`);
    writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
    return file;
  }
}


