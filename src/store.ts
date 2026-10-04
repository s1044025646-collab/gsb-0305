import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ApiError,
  Direction,
  LIMITS,
  ModelConfig,
  PendingRequest,
  RequestInput,
  RunState,
  RunStatus,
  StepEvent,
  validateModelConfig,
  validateRequest,
} from "./types";
import { EngineState, runSteps, stateFromRun } from "./engine";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cylinders INTEGER NOT NULL,
  initial_position INTEGER NOT NULL,
  initial_direction TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  model_id INTEGER NOT NULL,
  request_id INTEGER NOT NULL,
  arrival INTEGER NOT NULL,
  cylinder INTEGER NOT NULL,
  PRIMARY KEY (model_id, request_id)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  time INTEGER NOT NULL,
  position INTEGER NOT NULL,
  direction TEXT NOT NULL,
  total_distance INTEGER NOT NULL,
  reversals INTEGER NOT NULL,
  max_time INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_requests (
  run_id INTEGER NOT NULL,
  request_id INTEGER NOT NULL,
  arrival INTEGER NOT NULL,
  cylinder INTEGER NOT NULL,
  served_at INTEGER,
  PRIMARY KEY (run_id, request_id)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  time INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
`;

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createModel(cfg: ModelConfig): number {
    validateModelConfig(cfg);
    const res = this.db
      .prepare(
        "INSERT INTO models (cylinders, initial_position, initial_direction, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(cfg.cylinders, cfg.initialPosition, cfg.initialDirection, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  getModel(id: number): {
    id: number;
    cylinders: number;
    initialPosition: number;
    initialDirection: Direction;
    version: number;
    status: string;
  } {
    const row = this.db
      .prepare(
        "SELECT id, cylinders, initial_position AS initialPosition, initial_direction AS initialDirection, version, status FROM models WHERE id = ?",
      )
      .get(id) as any;
    if (!row) throw new ApiError("MODEL_NOT_FOUND", `模型 ${id} 不存在`, 404);
    return row;
  }

  listModels(): unknown[] {
    return this.db
      .prepare(
        "SELECT id, cylinders, initial_position AS initialPosition, initial_direction AS initialDirection, version, status, created_at AS createdAt FROM models ORDER BY id",
      )
      .all();
  }

  addRequests(modelId: number, reqs: RequestInput[]): number {
    const model = this.getModel(modelId);
    if (model.status !== "open") {
      throw new ApiError(
        "MODEL_LOCKED",
        "模型已开始运行，到达表不可原地修改；请创建新版本",
        409,
      );
    }
    if (!Array.isArray(reqs) || reqs.length === 0) {
      throw new ApiError("INVALID_PARAM", "requests 必须是非空数组");
    }
    const existing = this.getRequests(modelId);
    if (existing.length + reqs.length > LIMITS.MAX_REQUESTS) {
      throw new ApiError("LIMIT_EXCEEDED", `请求总数超过上限 ${LIMITS.MAX_REQUESTS}`);
    }
    const seen = new Set(existing.map((r) => r.requestId));
    for (const r of reqs) {
      validateRequest(r, model.cylinders);
      if (seen.has(r.requestId)) {
        throw new ApiError("DUPLICATE_REQUEST_ID", `请求编号 ${r.requestId} 重复`, 409);
      }
      seen.add(r.requestId);
    }
    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare(
        "INSERT INTO requests (model_id, request_id, arrival, cylinder) VALUES (?, ?, ?, ?)",
      );
      for (const r of reqs) stmt.run(modelId, r.requestId, r.arrival, r.cylinder);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return reqs.length;
  }

  getRequests(modelId: number): RequestInput[] {
    return this.db
      .prepare(
        "SELECT request_id AS requestId, arrival, cylinder FROM requests WHERE model_id = ? ORDER BY arrival, request_id",
      )
      .all(modelId) as any[];
  }

  /** 复制模型与请求表为新版本，返回新模型 id。 */
  createVersion(modelId: number): number {
    const model = this.getModel(modelId);
    const newId = this.createModel({
      cylinders: model.cylinders,
      initialPosition: model.initialPosition,
      initialDirection: model.initialDirection,
    });
    this.db
      .prepare("UPDATE models SET version = ? WHERE id = ?")
      .run(model.version + 1, newId);
    const reqs = this.getRequests(modelId);
    const stmt = this.db.prepare(
      "INSERT INTO requests (model_id, request_id, arrival, cylinder) VALUES (?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const r of reqs) stmt.run(newId, r.requestId, r.arrival, r.cylinder);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return newId;
  }

  startRun(modelId: number, maxTime: number = LIMITS.MAX_TIME): number {
    const model = this.getModel(modelId);
    if (!Number.isInteger(maxTime) || maxTime <= 0 || maxTime > LIMITS.MAX_TIME) {
      throw new ApiError("INVALID_PARAM", `maxTime 必须在 1..${LIMITS.MAX_TIME}`);
    }
    const reqs = this.getRequests(modelId);
    this.db.exec("BEGIN");
    try {
      const res = this.db
        .prepare(
          "INSERT INTO runs (model_id, status, time, position, direction, total_distance, reversals, max_time, seq, created_at) VALUES (?, 'running', 0, ?, ?, 0, 0, ?, 0, ?)",
        )
        .run(
          modelId,
          model.initialPosition,
          model.initialDirection,
          maxTime,
          new Date().toISOString(),
        );
      const runId = Number(res.lastInsertRowid);
      const stmt = this.db.prepare(
        "INSERT INTO run_requests (run_id, request_id, arrival, cylinder) VALUES (?, ?, ?, ?)",
      );
      for (const r of reqs) stmt.run(runId, r.requestId, r.arrival, r.cylinder);
      this.db
        .prepare("UPDATE models SET status = 'locked' WHERE id = ?")
        .run(modelId);
      this.db.exec("COMMIT");
      return runId;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getRun(runId: number): RunState & { seq: number } {
    const row = this.db
      .prepare(
        "SELECT id AS runId, model_id AS modelId, status, time, position, direction, total_distance AS totalDistance, reversals, max_time AS maxTime, seq FROM runs WHERE id = ?",
      )
      .get(runId) as any;
    if (!row) throw new ApiError("RUN_NOT_FOUND", `运行 ${runId} 不存在`, 404);
    return row;
  }

  listRuns(modelId?: number): unknown[] {
    const sql =
      "SELECT id AS runId, model_id AS modelId, status, time, position, direction, total_distance AS totalDistance, reversals FROM runs" +
      (modelId != null ? " WHERE model_id = ?" : "") +
      " ORDER BY id";
    return modelId != null ? this.db.prepare(sql).all(modelId) : this.db.prepare(sql).all();
  }

  private getPending(runId: number): PendingRequest[] {
    return this.db
      .prepare(
        "SELECT request_id AS requestId, arrival, cylinder FROM run_requests WHERE run_id = ? AND served_at IS NULL",
      )
      .all(runId) as any[];
  }

  /** 推进 count 步（默认 1），原子写入事件与状态。 */
  advance(runId: number, count: number = 1): { events: StepEvent[]; state: RunState } {
    if (!Number.isInteger(count) || count < 1 || count > LIMITS.MAX_STEPS_PER_CALL) {
      throw new ApiError(
        "INVALID_PARAM",
        `步数必须是 1..${LIMITS.MAX_STEPS_PER_CALL} 的整数`,
      );
    }
    const run = this.getRun(runId);
    if (run.status === "completed") {
      return { events: [], state: run };
    }
    if (run.status === "paused") {
      // 暂停后可继续推进：恢复为 running
      this.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(runId);
      run.status = "running";
    }
    const pending = this.getPending(runId);
    const state: EngineState = stateFromRun(run, run.seq);
    const { events, served } = runSteps(state, pending, count, run.maxTime);
    if (state.status === "running") {
      // 预算耗尽
      state.status = "paused";
      events.push({
        seq: state.seq,
        time: state.time,
        type: "paused",
        admitted: [],
        served: [],
        queueBefore: [],
        reversed: false,
        direction: state.direction,
        from: state.position,
        to: state.position,
        note: `步数预算 ${count} 耗尽，运行暂停，待处理 ${this.countRemaining(pending, served)} 项`,
      });
      state.seq += 1;
    }
    this.db.exec("BEGIN");
    try {
      const evStmt = this.db.prepare(
        "INSERT INTO events (run_id, seq, time, type, payload) VALUES (?, ?, ?, ?, ?)",
      );
      for (const e of events) evStmt.run(runId, e.seq, e.time, e.type, JSON.stringify(e));
      const srvStmt = this.db.prepare(
        "UPDATE run_requests SET served_at = ? WHERE run_id = ? AND request_id = ?",
      );
      for (const s of served) srvStmt.run(s.completedAt, runId, s.requestId);
      this.db
        .prepare(
          "UPDATE runs SET status = ?, time = ?, position = ?, direction = ?, total_distance = ?, reversals = ?, seq = ? WHERE id = ?",
        )
        .run(
          state.status,
          state.time,
          state.position,
          state.direction,
          state.totalDistance,
          state.reversals,
          state.seq,
          runId,
        );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { events, state: this.getRun(runId) };
  }

  private countRemaining(pending: PendingRequest[], served: { requestId: number }[]): number {
    const done = new Set(served.map((s) => s.requestId));
    return pending.filter((p) => !done.has(p.requestId)).length;
  }

  getEvents(runId: number): StepEvent[] {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE run_id = ? ORDER BY seq, id")
      .all(runId) as any[];
    return rows.map((r) => JSON.parse(r.payload));
  }

  getRunRequests(runId: number): {
    served: Array<RequestInput & { completedAt: number; wait: number }>;
    pending: RequestInput[];
  } {
    const served = this.db
      .prepare(
        "SELECT request_id AS requestId, arrival, cylinder, served_at AS completedAt, served_at - arrival AS wait FROM run_requests WHERE run_id = ? AND served_at IS NOT NULL ORDER BY served_at, arrival, request_id",
      )
      .all(runId) as any[];
    const pending = this.db
      .prepare(
        "SELECT request_id AS requestId, arrival, cylinder FROM run_requests WHERE run_id = ? AND served_at IS NULL ORDER BY arrival, request_id",
      )
      .all(runId) as any[];
    return { served, pending };
  }

  getStats(runId: number): unknown {
    const run = this.getRun(runId);
    const { served, pending } = this.getRunRequests(runId);
    const waits = served.map((s) => s.wait);
    return {
      runId: run.runId,
      modelId: run.modelId,
      status: run.status,
      time: run.time,
      position: run.position,
      direction: run.direction,
      totalDistance: run.totalDistance,
      reversals: run.reversals,
      servedCount: served.length,
      pendingCount: pending.length,
      totalWait: waits.reduce((a, b) => a + b, 0),
      maxWait: waits.length ? Math.max(...waits) : 0,
      avgWait: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0,
      serviceOrder: served.map((s) => s.requestId),
    };
  }

  exportRun(runId: number): unknown {
    const run = this.getRun(runId);
    const model = this.getModel(run.modelId);
    return {
      model,
      run: this.getStats(runId),
      requests: this.getRunRequests(runId),
      events: this.getEvents(runId),
    };
  }
}

export function defaultDbPath(): string {
  return path.join(process.cwd(), "data", "look.db");
}

export type { RunStatus };
