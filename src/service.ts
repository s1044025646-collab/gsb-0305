import { DEFAULT_STEP_BUDGET, MAX_STEP_BUDGET, MAX_TIME } from "./config.js";
import { initRunState, stepMany, stepOnce } from "./engine.js";
import { SimError } from "./errors.js";
import { Store } from "./store.js";
import type {
  Direction,
  RequestInput,
  RunState,
  SimEvent,
  ServedRequest,
  VersionSnapshot,
} from "./types.js";

export interface Statistics {
  totalRequests: number;
  servedCount: number;
  pendingCount: number;
  currentTime: number;
  finalHead: number;
  direction: Direction;
  totalDistance: number;
  reversals: number;
  totalWait: number;
  averageWait: number | null;
  maxWait: number | null;
  status: RunState["status"];
}

export interface RunReport {
  version: VersionSnapshot;
  run: RunState | null;
  statistics: Statistics | null;
  serviceOrder: ServedRequest[];
  events: SimEvent[];
}

export class SimService {
  constructor(readonly store: Store) {}

  createModel(name: string) {
    return this.store.createModel(name);
  }

  createVersion(
    modelId: number,
    maxCylinder: number,
    initialHead: number,
    initialDirection: Direction,
    requests: RequestInput[],
  ): VersionSnapshot {
    return this.store.createVersion(
      modelId,
      maxCylinder,
      initialHead,
      initialDirection,
      requests,
    );
  }

 private requireVersion(versionId: number): VersionSnapshot {
    const version = this.store.getVersion(versionId);
    if (!version) throw new SimError("NOT_FOUND", `请求版本 ${versionId} 不存在`);
    return version;
  }

  /** 开始运行：初始化状态并原子落盘；已开始则返回当前运行（重启继续不重置方向）。 */
  startRun(versionId: number): { run: RunState; created: boolean } {
    const version = this.requireVersion(versionId);
    const existing = this.store.getRunByVersion(versionId);
    if (existing) return { run: existing, created: false };
    const state = initRunState({ runId: 0, version });
    this.store.saveProgress(state, [], true);
    return { run: this.store.getRunByVersion(versionId)!, created: true };
  }

  private loadForAdvance(versionId: number): { state: RunState; version: VersionSnapshot } {
    const version = this.requireVersion(versionId);
    let state = this.store.getRunByVersion(versionId);
    if (!state) {
      state = initRunState({ runId: 0, version });
      this.store.saveProgress(state, [], true);
      state = this.store.getRunByVersion(versionId)!;
    }
    return { state, version };
  }

  /** 单步推进一个仿真周期；批量推进只是多次调用本逻辑，二者严格一致。 */
  step(versionId: number): { state: RunState; events: SimEvent[] } {
    const { state, version } = this.loadForAdvance(versionId);
    const result = stepOnce(state, version, 1);
    this.store.saveProgress(result.state, this.numberEvents(result.state, result.events), false);
    return { state: result.state, events: result.events };
  }

  advance(versionId: number, budget?: number): {
    state: RunState;
    events: SimEvent[];
    budgetLeft: number;
    paused: boolean;
  } {
    const requested = budget ?? DEFAULT_STEP_BUDGET;
    const { state, version } = this.loadForAdvance(versionId);
    const result = stepMany(state, version, requested);
    this.store.saveProgress(result.state, this.numberEvents(result.state, result.events), false);
    return result;
  }

  private numberEvents(state: RunState, events: SimEvent[]): SimEvent[] {
    const existing = this.store.listEvents(state.runId);
    let seq = existing.length === 0 ? 0 : existing[existing.length - 1].seq;
    return events.map((event) => ({ ...event, seq: ++seq }));
  }

  getRun(versionId: number): RunState | null {
    return this.store.getRunByVersion(versionId) ?? null;
  }

  getEvents(versionId: number): SimEvent[] {
    const run = this.store.getRunByVersion(versionId);
    if (!run) return [];
    return this.store.listEvents(run.runId);
  }

  getStatistics(versionId: number): Statistics | null {
    const version = this.requireVersion(versionId);
    const run = this.store.getRunByVersion(versionId);
    if (!run) return null;
    const waits = run.served.map((r) => r.wait);
    const totalWait = waits.reduce((sum, w) => sum + w, 0);
    return {
      totalRequests: version.requests.length,
      servedCount: run.served.length,
      pendingCount: run.pendingIds.length,
      currentTime: run.time,
      finalHead: run.head,
      direction: run.direction,
      totalDistance: run.distance,
      reversals: run.reversals,
      totalWait,
      averageWait: waits.length ? totalWait / waits.length : null,
      maxWait: waits.length ? Math.max(...waits) : null,
      status: run.status,
    };
  }

  getReport(versionId: number): RunReport {
    const version = this.requireVersion(versionId);
    const run = this.store.getRunByVersion(versionId) ?? null;
    return {
      version,
      run,
      statistics: run ? this.getStatistics(versionId) : null,
      serviceOrder: run ? run.served : [],
      events: run ? this.store.listEvents(run.runId) : [],
    };
  }

  exportJson(versionId: number): { file: string; payload: RunReport } {
    const payload = this.getReport(versionId);
    const file = this.store.writeJsonExport(versionId, payload);
    return { file, payload };
  }

  limits() {
    return { MAX_TIME, MAX_STEP_BUDGET, DEFAULT_STEP_BUDGET };
  }
}
