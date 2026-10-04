import {
  Direction,
  PendingRequest,
  RunState,
  StepEvent,
} from "./types";

export interface EngineState {
  time: number;
  position: number;
  direction: Direction;
  totalDistance: number;
  reversals: number;
  status: "running" | "paused" | "completed";
  seq: number;
}

export interface StepResult {
  events: StepEvent[];
  servedNow: Array<{ requestId: number; arrival: number; cylinder: number; completedAt: number }>;
  state: EngineState;
}

function sortQueue(queue: PendingRequest[]): PendingRequest[] {
  return [...queue].sort((a, b) => a.arrival - b.arrival || a.requestId - b.requestId);
}

/**
 * 推进一个时间步（或一次空闲跳转）。
 * 语义：
 * 1. 纳入 arrival <= t 的请求（arrival == t 的为本刻新到）。
 * 2. 服务当前柱面全部已到达请求（按 arrival, requestId 稳定排序）。
 * 3. 队列非空：当前方向有待处理柱面则前进一格；否则反向并前进一格。
 * 4. 队列空：跳到下一到达时刻（idle 事件），若无未来请求则完成。
 */
export function stepOnce(
  state: EngineState,
  pending: PendingRequest[],
  maxTime: number,
): StepResult {
  const events: StepEvent[] = [];
  const servedNow: StepResult["servedNow"] = [];
  if (state.status !== "running") {
    return { events, servedNow, state };
  }
  const t = state.time;
  const arrived = pending.filter((r) => r.arrival <= t);
  const admitted = pending.filter((r) => r.arrival === t).map((r) => r.requestId);
  const atHead = sortQueue(arrived.filter((r) => r.cylinder === state.position));
  for (const r of atHead) {
    servedNow.push({
      requestId: r.requestId,
      arrival: r.arrival,
      cylinder: r.cylinder,
      completedAt: t,
    });
  }
  const servedIds = new Set(atHead.map((r) => r.requestId));
  const remaining = arrived.filter((r) => !servedIds.has(r.requestId));
  const queueBefore = sortQueue(remaining).map((r) => ({
    requestId: r.requestId,
    cylinder: r.cylinder,
    arrival: r.arrival,
  }));

  const base: Omit<StepEvent, "type"> = {
    seq: state.seq,
    time: t,
    admitted,
    served: atHead.map((r) => r.requestId),
    queueBefore,
    reversed: false,
    direction: state.direction,
    from: state.position,
    to: null,
  };

  if (remaining.length > 0) {
    const upHas = remaining.some((r) => r.cylinder > state.position);
    const downHas = remaining.some((r) => r.cylinder < state.position);
    let dir = state.direction;
    let reversed = false;
    if (dir === "up" && !upHas && downHas) {
      dir = "down";
      reversed = true;
    } else if (dir === "down" && !downHas && upHas) {
      dir = "up";
      reversed = true;
    }
    const delta = dir === "up" ? 1 : -1;
    const next = state.position + delta;
    state.position = next;
    state.direction = dir;
    state.totalDistance += 1;
    if (reversed) state.reversals += 1;
    state.time = t + 1;
    events.push({ ...base, type: "tick", reversed, direction: dir, to: next });
  } else {
    const future = pending.filter((r) => !servedIds.has(r.requestId) && r.arrival > t);
    if (future.length > 0) {
      const nextArrival = Math.min(...future.map((r) => r.arrival));
      events.push({
        ...base,
        type: "idle",
        to: state.position,
        idleFrom: t,
        idleTo: nextArrival,
        note: `空闲等待 [${t}, ${nextArrival})，不计入寻道距离`,
      });
      state.time = nextArrival;
    } else {
      state.status = "completed";
      events.push({ ...base, type: "completed", to: state.position, note: "全部请求已服务" });
    }
  }
  state.seq += 1;
  if (state.time > maxTime && state.status === "running") {
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
      note: `超过最大时间 maxTime=${maxTime}，运行暂停`,
    });
    state.seq += 1;
  }
  return { events, servedNow, state };
}

/** 批量推进 count 步；预算耗尽且未完成时标记 paused。 */
export function runSteps(
  state: EngineState,
  pending: PendingRequest[],
  count: number,
  maxTime: number,
): { events: StepEvent[]; served: StepResult["servedNow"]; remaining: PendingRequest[] } {
  const allEvents: StepEvent[] = [];
  const allServed: StepResult["servedNow"] = [];
  let rest = [...pending];
  for (let i = 0; i < count && state.status === "running"; i++) {
    const res = stepOnce(state, rest, maxTime);
    allEvents.push(...res.events);
    allServed.push(...res.servedNow);
    const done = new Set(res.servedNow.map((s) => s.requestId));
    rest = rest.filter((r) => !done.has(r.requestId));
  }
  return { events: allEvents, served: allServed, remaining: rest };
}

export function stateFromRun(run: RunState, seq: number): EngineState {
  return {
    time: run.time,
    position: run.position,
    direction: run.direction,
    totalDistance: run.totalDistance,
    reversals: run.reversals,
    status: run.status,
    seq,
  };
}
