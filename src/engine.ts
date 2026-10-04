import { MAX_TIME } from "./config.js";
import { SimError } from "./errors.js";
import type {
  Direction,
  RequestInput,
  RunState,
  SimEvent,
  ServedRequest,
  StepResult,
  VersionSnapshot,
} from "./types.js";

export interface InitRunInput {
  runId: number;
  version: VersionSnapshot;
}

/**
 * 创建运行的初始状态：磁头位于初始柱面、保持初始方向、时刻 0、队列为空。
 */
export function initRunState({ runId, version }: InitRunInput): RunState {
  return {
    runId,
    versionId: version.id,
    time: 0,
    head: version.initialHead,
    direction: version.initialDirection,
    distance: 0,
    reversals: 0,
    status: "running",
    pendingIds: [],
    served: [],
    nextArrivalIndex: 0,
  };
}

function sortRequests(requests: RequestInput[]): RequestInput[] {
  return [...requests].sort((a, b) =>
    a.arrival !== b.arrival ? a.arrival - b.arrival : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

export interface InternalState extends RunState {
  requests: RequestInput[];
  maxCylinder: number;
}

function toInternal(state: RunState, version: VersionSnapshot): InternalState {
  return { ...state, requests: sortRequests(version.requests), maxCylinder: version.maxCylinder };
}

function nextSeq(events: SimEvent[]): number {
  return events.length === 0 ? 1 : events[events.length - 1].seq + 1;
}

/**
 * 推进一个仿真周期。单步与批量推进共用本函数，二者结果严格一致。
 *
 * 周期顺序（时刻 t）：
 * 1. 纳入所有到达时刻为 t 的请求；
 * 2. 一次服务当前柱面全部待处理请求（按到达时刻、编号稳定排序）；
 * 3. 仍有请求时决定方向并最多移动一格；当前方向无请求而反方向有则立即反向；
 * 4. 无待处理但有未来到达时，直接跳到下一到达时刻，记录等待区间，不计寻道距离。
 */
export function stepOnce(
  state: RunState,
  version: VersionSnapshot,
  budgetLeft: number,
): StepResult {
  if (state.status === "complete") {
    throw new SimError("CONFLICT", "运行已完成，无法继续推进");
  }
  if (state.status === "paused" && budgetLeft <= 0) {
    throw new SimError("BUDGET_EXHAUSTED", "运行因步数预算耗尽暂停，请携带更大预算继续推进");
  }
  if (state.status === "paused" && budgetLeft > 0) {
    state = { ...state, status: "running" };
  }
  if (budgetLeft <= 0) {
    return pause(state, [], budgetLeft, "推进预算为 0，仿真暂停并保留全部待处理请求");
  }

  const internal = toInternal(state, version);
  const events: SimEvent[] = [];
  let seq = nextSeq(events);

  const t = internal.time;

  // 1. 纳入本时刻到达的请求（仅可见到达时刻 <= 当前时刻的请求，不提前看未来）。
  const admitted: RequestInput[] = [];
  while (
    internal.nextArrivalIndex < internal.requests.length &&
    internal.requests[internal.nextArrivalIndex].arrival <= t
  ) {
    const req = internal.requests[internal.nextArrivalIndex];
    if (req.arrival === t) admitted.push(req);
    internal.nextArrivalIndex++;
  }
  if (admitted.length > 0) {
    for (const req of admitted) internal.pendingIds.push(req.id);
    events.push({
      seq: seq++,
      time: t,
      type: "ARRIVALS",
      head: internal.head,
      direction: internal.direction,
      detail: `时刻 ${t}：到达 ${admitted.length} 个请求（柱面 ${admitted
        .map((r) => `${r.id}→${r.cylinder}`)
        .join("，")}）`,
      requestIds: admitted.map((r) => r.id),
    });
  }

  // 2. 服务当前柱面的全部待处理请求，按（到达时刻，编号）稳定排序。
  const pendingReqs = internal.pendingIds.map((id) =>
    internal.requests.find((r) => r.id === id)!,
  );
  const here = pendingReqs
    .filter((r) => r.cylinder === internal.head)
    .sort((a, b) =>
      a.arrival !== b.arrival ? a.arrival - b.arrival : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  if (here.length > 0) {
    const hereIds = new Set(here.map((r) => r.id));
    internal.pendingIds = internal.pendingIds.filter((id) => !hereIds.has(id));
    for (const req of here) {
      const served: ServedRequest = {
        ...req,
        completion: t,
        wait: t - req.arrival,
      };
      internal.served.push(served);
    }
    events.push({
      seq: seq++,
      time: t,
      type: "SERVICE",
      head: internal.head,
      direction: internal.direction,
      detail: `时刻 ${t}：柱面 ${internal.head} 服务 ${here.length} 个请求（${here
        .map((r) => r.id)
        .join("，")}），不产生移动`,
      requestIds: here.map((r) => r.id),
      queueIds: [...internal.pendingIds],
    });
  }

  const hasFuture = internal.nextArrivalIndex < internal.requests.length;

  // 3. 全部完成。
  if (internal.pendingIds.length === 0 && !hasFuture) {
    internal.status = "complete";
    events.push({
      seq: seq++,
      time: t,
      type: "COMPLETE",
      head: internal.head,
      direction: internal.direction,
      detail: `时刻 ${t}：队列已空且无未来到达，仿真完成。最终柱面 ${internal.head}，总移动距离 ${internal.distance}，反向 ${internal.reversals} 次`,
    });
    return { state: strip(internal), events, budgetLeft: budgetLeft - 1 };
  }

  // 4. 空闲但有未来到达：跳到下一到达时刻（不允许越过中途到达事件）。
  if (internal.pendingIds.length === 0 && hasFuture) {
    const nextArrival = internal.requests[internal.nextArrivalIndex].arrival;
    if (nextArrival > MAX_TIME) {
      return pause(
        strip(internal),
        events,
        budgetLeft - 1,
        `下一到达时刻 ${nextArrival} 超出最大时间 ${MAX_TIME}`,
      );
    }
    events.push({
      seq: seq++,
      time: t,
      type: "WAIT_SKIP",
      head: internal.head,
      direction: internal.direction,
      detail: `时刻 ${t}：无待处理请求，保持柱面 ${internal.head} 与方向 ${dirText(
        internal.direction,
      )}，空闲跳过等待区间 [${t}, ${nextArrival})，于时刻 ${nextArrival} 处理新到达；跳过不计寻道距离`,
      nextHead: internal.head,
    });
    internal.time = nextArrival;
    return { state: strip(internal), events, budgetLeft: budgetLeft - 1 };
  }

  // 5. 有待处理请求：LOOK 方向选择（只依据当前队列，不看未来请求）。
  const pending = internal.pendingIds.map((id) => internal.requests.find((r) => r.id === id)!);
  const aheadCurrent = pending.some(
    (r) => (r.cylinder - internal.head) * internal.direction > 0,
  );
  let reversed = false;
  if (!aheadCurrent) {
    const aheadOpposite = pending.some(
      (r) => (r.cylinder - internal.head) * -internal.direction > 0,
    );
    if (aheadOpposite) {
      internal.direction = (-internal.direction) as Direction;
      internal.reversals++;
      reversed = true;
      events.push({
        seq: seq++,
        time: t,
        type: "REVERSE",
        head: internal.head,
        direction: internal.direction,
        detail: `时刻 ${t}：当前方向（${dirText((-internal.direction) as Direction)}）已无待处理柱面，反方向存在请求，立即反向为 ${dirText(
          internal.direction as Direction,
        )}（累计反向 ${internal.reversals} 次）`,
        queueIds: [...internal.pendingIds],
        reversed: true,
      });
    }
  }

  const nextHead = internal.head + internal.direction;
  if (nextHead < 0 || nextHead > internal.maxCylinder) {
    return pause(
      strip(internal),
      events,
      budgetLeft - 1,
      `下一位置柱面 ${nextHead} 超出边界 [0, ${internal.maxCylinder}]，仿真暂停`,
    );
  }
  internal.head = nextHead;
  internal.distance++;
  internal.time++;
  events.push({
    seq: seq++,
    time: t,
    type: "MOVE",
    head: internal.head - internal.direction,
    direction: internal.direction,
    detail: `时刻 ${t}：朝${dirText(internal.direction)}移动一格，柱面 ${internal.head - internal.direction} → ${
      internal.head
    }，时刻推进到 ${internal.time}；移动后才处理新到达与新位置服务`,
    nextHead: internal.head,
    reversed,
    distanceDelta: 1,
    queueIds: [...internal.pendingIds],
  });

  if (internal.time > MAX_TIME) {
    return pause(strip(internal), events, budgetLeft - 1, `时刻超过最大时间 ${MAX_TIME}`);
  }
  return { state: strip(internal), events, budgetLeft: budgetLeft - 1 };
}

function pause(
  state: RunState,
  events: SimEvent[],
  budgetLeft: number,
  detail: string,
): StepResult {
  state.status = "paused";
  events.push({
    seq: events.length === 0 ? 1 : events[events.length - 1].seq + 1,
    time: state.time,
    type: "PAUSED",
    head: state.head,
    direction: state.direction,
    detail: `时刻 ${state.time}：${detail}；保留 ${state.pendingIds.length} 个待处理请求，未标记完成`,
    queueIds: [...state.pendingIds],
  });
  return { state, events, budgetLeft };
}

function strip(internal: InternalState): RunState {
  const { requests: _requests, maxCylinder: _max, ...rest } = internal;
  void _requests;
  void _max;
  return rest;
}

function dirText(dir: Direction): string {
  return dir === 1 ? "上(柱面号增大)" : "下(柱面号减小)";
}

/**
 * 批量推进：反复调用 stepOnce 直到完成、暂停或预算耗尽。与连续单步完全等价。
 */
export function stepMany(
  state: RunState,
  version: VersionSnapshot,
  budget: number,
): { state: RunState; events: SimEvent[]; budgetLeft: number; paused: boolean } {
  const all: SimEvent[] = [];
  let current = state;
  let left = budget;
  for (;;) {
    const result = stepOnce(current, version, left);
    all.push(...result.events);
    current = result.state;
    left = result.budgetLeft;
    if (current.status !== "running") {
      return { state: current, events: all, budgetLeft: left, paused: current.status === "paused" };
    }
  }
}
