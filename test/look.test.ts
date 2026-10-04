import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store";
import { ApiError } from "../src/types";

function memStore(): Store {
  return new Store(":memory:");
}

function fullRun(store: Store, modelId: number, steps = 1000): number {
  const runId = store.startRun(modelId);
  store.advance(runId, steps);
  return runId;
}

test("演示场景：5 号柱面向上，t0 请求 2 和 7，总距离 7", () => {
  const s = memStore();
  const m = s.createModel({ cylinders: 10, initialPosition: 5, initialDirection: "up" });
  s.addRequests(m, [
    { requestId: 1, arrival: 0, cylinder: 2 },
    { requestId: 2, arrival: 0, cylinder: 7 },
  ]);
  const runId = fullRun(s, m);
  const stats: any = s.getStats(runId);
  assert.equal(stats.status, "completed");
  assert.deepEqual(stats.serviceOrder, [2, 1]);
  assert.equal(stats.totalDistance, 7);
  assert.equal(stats.reversals, 1);
  assert.equal(stats.position, 2);
  assert.equal(stats.time, 7);
  const { served, pending } = s.getRunRequests(runId);
  assert.equal(pending.length, 0);
  const byId = new Map(served.map((r) => [r.requestId, r]));
  assert.equal(byId.get(2)!.completedAt, 2);
  assert.equal(byId.get(2)!.wait, 2);
  assert.equal(byId.get(1)!.completedAt, 7);
  assert.equal(byId.get(1)!.wait, 7);
  // 移动距离 = 位置变化绝对值之和
  const ticks = s.getEvents(runId).filter((e) => e.type === "tick");
  const dist = ticks.reduce((a, e) => a + Math.abs((e.to as number) - e.from), 0);
  assert.equal(dist, stats.totalDistance);
  // 无丢失无重复
  assert.deepEqual([...stats.serviceOrder].sort(), [1, 2]);
});

test("同柱面多个请求零等待且不增加移动", () => {
  const s = memStore();
  const m = s.createModel({ cylinders: 10, initialPosition: 3, initialDirection: "up" });
  s.addRequests(m, [
    { requestId: 1, arrival: 0, cylinder: 3 },
    { requestId: 2, arrival: 0, cylinder: 3 },
    { requestId: 3, arrival: 1, cylinder: 3 },
  ]);
  const runId = fullRun(s, m);
  const stats: any = s.getStats(runId);
  assert.equal(stats.totalDistance, 0);
  assert.equal(stats.reversals, 0);
  assert.deepEqual(stats.serviceOrder, [1, 2, 3]);
  const { served } = s.getRunRequests(runId);
  assert.deepEqual(served.map((r) => r.wait), [0, 0, 0]);
  assert.equal(stats.time, 1);
});

test("初始方向无请求时立即反向，不需要走到物理边缘", () => {
  const s = memStore();
  const m = s.createModel({ cylinders: 10, initialPosition: 5, initialDirection: "up" });
  s.addRequests(m, [{ requestId: 1, arrival: 0, cylinder: 2 }]);
  const runId = fullRun(s, m);
  const stats: any = s.getStats(runId);
  assert.equal(stats.totalDistance, 3);
  assert.equal(stats.reversals, 1);
  assert.equal(stats.position, 2);
  const first = s.getEvents(runId)[0];
  assert.equal(first.reversed, true);
  assert.equal(first.to, 4);
});

test("请求恰好到达当前磁头位置时同刻服务", () => {
  const s = memStore();
  const m = s.createModel({ cylinders: 10, initialPosition: 4, initialDirection: "down" });
  s.addRequests(m, [
    { requestId: 1, arrival: 0, cylinder: 0 },
    { requestId: 2, arrival: 2, cylinder: 2 }, // t=2 时磁头正好在 2
  ]);
  const runId = fullRun(s, m);
  const { served } = s.getRunRequests(runId);
  const r2 = served.find((r) => r.requestId === 2)!;
  assert.equal(r2.completedAt, 2);
  assert.equal(r2.wait, 0);
});

test("长时间空闲：直接跳到下一到达时刻且不计距离", () => {
  const s = memStore();
  const m = s.createModel({ cylinders: 10, initialPosition: 0, initialDirection: "up" });
  s.addRequests(m, [{ requestId: 1, arrival: 100, cylinder: 3 }]);
  const runId = fullRun(s, m);
  const stats: any = s.getStats(runId);
  assert.equal(stats.totalDistance, 3);
  assert.equal(stats.time, 103);
  const idle = s.getEvents(runId).find((e) => e.type === "idle")!;
  assert.equal(idle.idleFrom, 0);
  assert.equal(idle.idleTo, 100);
});

test("空闲期间到达事件不会被越过（有待处理时不跳过）", () => {
  const s = memStore();
  const m = s.createModel({ cylinders: 10, initialPosition: 5, initialDirection: "up" });
  s.addRequests(m, [
    { requestId: 1, arrival: 0, cylinder: 9 },
    { requestId: 2, arrival: 2, cylinder: 6 }, // 移动途中到达的近端请求
  ]);
  const runId = fullRun(s, m);
  const stats: any = s.getStats(runId);
  // t=2 磁头在 7，请求 2 在 6（下方），LOOK 继续向上到 9 再反向
  assert.deepEqual(stats.serviceOrder, [1, 2]);
  assert.equal(stats.totalDistance, 4 + 3);
});

test("边缘反向：在 0 号柱面方向向下时立即反向", () => {
  const s = memStore();
  const m = s.createModel({ cylinders: 5, initialPosition: 0, initialDirection: "down" });
  s.addRequests(m, [{ requestId: 1, arrival: 0, cylinder: 2 }]);
  const runId = fullRun(s, m);
  const stats: any = s.getStats(runId);
  assert.equal(stats.reversals, 1);
  assert.equal(stats.totalDistance, 2);
  assert.equal(stats.position, 2);
});

test("单步与批量推进结果一致", () => {
  const setup = (): { s: Store; runId: number } => {
    const s = memStore();
    const m = s.createModel({ cylinders: 10, initialPosition: 5, initialDirection: "up" });
    s.addRequests(m, [
      { requestId: 1, arrival: 0, cylinder: 2 },
      { requestId: 2, arrival: 0, cylinder: 7 },
      { requestId: 3, arrival: 1, cylinder: 6 },
      { requestId: 4, arrival: 3, cylinder: 0 },
    ]);
    return { s, runId: s.startRun(m) };
  };
  const a = setup();
  a.s.advance(a.runId, 1000);
  const b = setup();
  for (let i = 0; i < 30; i++) b.s.advance(b.runId, 1);
  assert.deepEqual(b.s.getStats(b.runId), a.s.getStats(a.runId));
  const core = (st: Store, runId: number) =>
    st
      .getEvents(runId)
      .filter((e) => e.type !== "paused")
      .map((e) => [e.type, e.time, e.from, e.to, e.reversed, e.served, e.admitted]);
  assert.deepEqual(core(b.s, b.runId), core(a.s, a.runId));
});

test("保存重启后继续推进与不间断运行一致", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "look-"));
  const dbFile = path.join(dir, "test.db");
  const build = (s: Store): number => {
    const m = s.createModel({ cylinders: 10, initialPosition: 5, initialDirection: "up" });
    s.addRequests(m, [
      { requestId: 1, arrival: 0, cylinder: 2 },
      { requestId: 2, arrival: 0, cylinder: 7 },
      { requestId: 3, arrival: 1, cylinder: 6 },
    ]);
    return s.startRun(m);
  };
  // 不间断
  const s1 = new Store(":memory:");
  const r1 = build(s1);
  s1.advance(r1, 1000);
  // 分段 + 重启
  let s2 = new Store(dbFile);
  const r2 = build(s2);
  s2.advance(r2, 2);
  s2.close();
  s2 = new Store(dbFile);
  const mid = s2.getRun(r2);
  assert.equal(mid.status, "paused");
  s2.advance(r2, 3);
  s2.close();
  s2 = new Store(dbFile);
  s2.advance(r2, 1000);
  assert.deepEqual(s2.getStats(r2), s1.getStats(r1));
  // paused 事件是分段推进的正常记录；核心业务事件必须一致
  const core = (runId: number, st: Store) =>
    st
      .getEvents(runId)
      .filter((e) => e.type !== "paused")
      .map((e) => ({ ...e, seq: undefined }));
  assert.deepEqual(core(r2, s2), core(r1, s1));
  s2.close();
});

test("步数预算耗尽标记暂停并保留待处理项", () => {
  const s = memStore();
  const m = s.createModel({ cylinders: 10, initialPosition: 5, initialDirection: "up" });
  s.addRequests(m, [{ requestId: 1, arrival: 0, cylinder: 9 }]);
  const runId = s.startRun(m);
  s.advance(runId, 2);
  const run = s.getRun(runId);
  assert.equal(run.status, "paused");
  const { pending } = s.getRunRequests(runId);
  assert.equal(pending.length, 1);
  s.advance(runId, 100);
  assert.equal(s.getRun(runId).status, "completed");
});

test("校验：重复编号、越界柱面、负时间、非法方向、非整数位置", () => {
  const s = memStore();
  assert.throws(
    () => s.createModel({ cylinders: 10, initialPosition: 1.5, initialDirection: "up" }),
    (e: ApiError) => e.code === "INVALID_PARAM",
  );
  assert.throws(
    () => s.createModel({ cylinders: 10, initialPosition: 0, initialDirection: "left" as any }),
    (e: ApiError) => e.code === "INVALID_DIRECTION",
  );
  assert.throws(
    () => s.createModel({ cylinders: 10, initialPosition: 10, initialDirection: "up" }),
    (e: ApiError) => e.code === "INVALID_POSITION",
  );
  const m = s.createModel({ cylinders: 10, initialPosition: 0, initialDirection: "up" });
  s.addRequests(m, [{ requestId: 1, arrival: 0, cylinder: 1 }]);
  assert.throws(
    () => s.addRequests(m, [{ requestId: 1, arrival: 0, cylinder: 2 }]),
    (e: ApiError) => e.code === "DUPLICATE_REQUEST_ID",
  );
  assert.throws(
    () => s.addRequests(m, [{ requestId: 2, arrival: -1, cylinder: 2 }]),
    (e: ApiError) => e.code === "INVALID_ARRIVAL",
  );
  assert.throws(
    () => s.addRequests(m, [{ requestId: 3, arrival: 0, cylinder: 10 }]),
    (e: ApiError) => e.code === "INVALID_CYLINDER",
  );
});

test("开始运行后到达表锁定，需创建新版本", () => {
  const s = memStore();
  const m = s.createModel({ cylinders: 10, initialPosition: 0, initialDirection: "up" });
  s.addRequests(m, [{ requestId: 1, arrival: 0, cylinder: 1 }]);
  s.startRun(m);
  assert.throws(
    () => s.addRequests(m, [{ requestId: 2, arrival: 0, cylinder: 2 }]),
    (e: ApiError) => e.code === "MODEL_LOCKED",
  );
  const m2 = s.createVersion(m);
  const model2 = s.getModel(m2);
  assert.equal(model2.version, 2);
  assert.equal(model2.status, "open");
  assert.equal(s.getRequests(m2).length, 1);
  s.addRequests(m2, [{ requestId: 2, arrival: 5, cylinder: 3 }]);
  assert.equal(s.getRequests(m2).length, 2);
  // 旧版本报告仍保留
  assert.equal(s.listRuns(m).length, 1);
});

test("空请求集直接完成", () => {
  const s = memStore();
  const m = s.createModel({ cylinders: 10, initialPosition: 4, initialDirection: "down" });
  const runId = s.startRun(m);
  s.advance(runId, 10);
  const stats: any = s.getStats(runId);
  assert.equal(stats.status, "completed");
  assert.equal(stats.totalDistance, 0);
  assert.equal(stats.time, 0);
});

test("超过 maxTime 暂停", () => {
  const s = memStore();
  const m = s.createModel({ cylinders: 10, initialPosition: 0, initialDirection: "up" });
  s.addRequests(m, [{ requestId: 1, arrival: 50, cylinder: 9 }]);
  const runId = s.startRun(m, 10);
  s.advance(runId, 100);
  assert.equal(s.getRun(runId).status, "paused");
});
