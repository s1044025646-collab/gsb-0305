import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initRunState, stepMany, stepOnce } from "../src/engine.js";
import type { RequestInput, VersionSnapshot } from "../src/types.js";

function makeVersion(
  requests: RequestInput[],
  opts: { maxCylinder?: number; initialHead?: number; initialDirection?: 1 | -1 } = {},
): VersionSnapshot {
  return {
    id: 1,
    modelId: 1,
    version: 1,
    maxCylinder: opts.maxCylinder ?? 10,
    initialHead: opts.initialHead ?? 5,
    initialDirection: opts.initialDirection ?? 1,
    requests,
    started: false,
    createdAt: "now",
  };
}

function runAll(requests: RequestInput[], opts?: Parameters<typeof makeVersion>[1], budget = 100_000) {
  const version = makeVersion(requests, opts);
  let state = initRunState({ runId: 1, version });
  const result = stepMany(state, version, budget);
  return { version, ...result };
}

describe("LOOK 基本场景", () => {
  it("磁头 5 向上，零时刻请求 2 与 7：先 7 后 2，总距离 7", () => {
    const { state } = runAll([
      { id: "R2", arrival: 0, cylinder: 2 },
      { id: "R7", arrival: 0, cylinder: 7 },
    ]);
    assert.equal(state.status, "complete");
    assert.deepEqual(state.served.map((r) => r.id), ["R7", "R2"]);
    assert.equal(state.distance, 7);
    assert.equal(state.reversals, 1);
    assert.equal(state.head, 2);
    assert.deepEqual(
      state.served.map((r) => r.completion),
      [2, 7],
    );
  });

  it("移动期间到达影响顺序：t1 到达 6、t3 到达 3", () => {
    const { state } = runAll([
      { id: "R2", arrival: 0, cylinder: 2 },
      { id: "R7", arrival: 0, cylinder: 7 },
      { id: "R6", arrival: 1, cylinder: 6 },
      { id: "R3", arrival: 3, cylinder: 3 },
    ]);
    // t0 在 5 → t1 到 6 服务 R6 → t2 到 7 服务 R7（队列只剩下方请求，立即反向）；
    // t3 回到 6 时 R3 才被纳入（移动后才处理到达）→ t6 到 3 服务 R3 → t7 到 2 服务 R2
    assert.deepEqual(state.served.map((r) => r.id), ["R6", "R7", "R3", "R2"]);
    assert.deepEqual(state.served.map((r) => r.completion), [1, 2, 6, 7]);
    assert.deepEqual(state.served.map((r) => r.wait), [0, 2, 3, 7]);
    assert.equal(state.distance, 7);
    assert.equal(state.reversals, 1);
  });

  it("同柱面多个请求一次服务，零额外移动且按（到达、编号）稳定排序", () => {
    const { state, events } = runAll([
      { id: "B", arrival: 0, cylinder: 5 },
      { id: "A", arrival: 0, cylinder: 5 },
      { id: "C", arrival: 0, cylinder: 5 },
    ]);
    assert.deepEqual(state.served.map((r) => r.id), ["A", "B", "C"]);
    assert.equal(state.distance, 0);
    assert.equal(state.time, 0);
    assert.ok(state.served.every((r) => r.wait === 0));
    assert.equal(events.filter((e) => e.type === "SERVICE").length, 1);
  });

  it("初始方向无请求而反方向有：先立即反向再移动", () => {
    const { state } = runAll([{ id: "X", arrival: 0, cylinder: 0 }], {
      initialHead: 5,
      initialDirection: 1,
    });
    assert.deepEqual(state.served.map((r) => r.id), ["X"]);
    assert.equal(state.distance, 5);
    assert.equal(state.reversals, 1);
  });

  it("请求恰好到达当前磁头：同刻零等待服务", () => {
    const { state } = runAll([{ id: "H", arrival: 4, cylinder: 5 }]);
    assert.equal(state.status, "complete");
    assert.equal(state.served[0].completion, 4);
    assert.equal(state.served[0].wait, 0);
    assert.equal(state.distance, 0);
  });

  it("长时间空闲：跳到下一到达，等待区间记录且不计距离", () => {
    const { state, events } = runAll([{ id: "L", arrival: 500, cylinder: 6 }]);
    assert.equal(state.distance, 1);
    assert.equal(state.time, 501);
    const wait = events.find((e) => e.type === "WAIT_SKIP")!;
    assert.match(wait.detail, /\[0, 500\)/);
    assert.equal(wait.nextHead, 5);
  });

  it("边缘反向：先服务柱面 10 再回头，不走到物理边缘之外", () => {
    const { state } = runAll(
      [
        { id: "E", arrival: 0, cylinder: 10 },
        { id: "Z", arrival: 0, cylinder: 0 },
      ],
      { initialHead: 9, initialDirection: 1, maxCylinder: 10 },
    );
    assert.deepEqual(state.served.map((r) => r.id), ["E", "Z"]);
    assert.equal(state.distance, 11);
    assert.equal(state.head, 0);
  });
});

describe("单步与批量一致性、预算与守恒", () => {
  it("逐周期单步结果等于一次性批量结果", () => {
    const requests = [
      { id: "R2", arrival: 0, cylinder: 2 },
      { id: "R7", arrival: 0, cylinder: 7 },
      { id: "R6", arrival: 1, cylinder: 6 },
      { id: "R3", arrival: 3, cylinder: 3 },
    ];
    const version = makeVersion(requests);
    const batch = stepMany(initRunState({ runId: 1, version }), version, 100_000).state;

    let single = initRunState({ runId: 1, version });
    for (let i = 0; i < 100_000 && single.status === "running"; i++) {
      single = stepOnce(single, version, 1).state;
    }
    assert.deepEqual(single, batch);
  });

  it("预算耗尽标记暂停并保留待处理项，加大预算后可跑完", () => {
    const requests = [
      { id: "R2", arrival: 0, cylinder: 2 },
      { id: "R7", arrival: 0, cylinder: 7 },
    ];
    const version = makeVersion(requests);
    let state = initRunState({ runId: 1, version });
    const paused = stepMany(state, version, 3);
    assert.equal(paused.state.status, "paused");
    assert.equal(paused.paused, true);
    assert.ok(paused.state.pendingIds.includes("R2"));
    const resumed = stepMany(paused.state, version, 100_000);
    assert.equal(resumed.state.status, "complete");
    assert.equal(resumed.state.distance, 7);
  });

  it("距离守恒：总距离等于相邻 MOVE 事件位置变化绝对值之和", () => {
    const requests = [
      { id: "a", arrival: 0, cylinder: 2 },
      { id: "b", arrival: 1, cylinder: 9 },
      { id: "c", arrival: 6, cylinder: 4 },
      { id: "d", arrival: 60, cylinder: 8 },
    ];
    const { state, events } = runAll(requests);
    const moves = events.filter((e) => e.type === "MOVE");
    const summed = moves.reduce((sum, e) => sum + Math.abs((e.nextHead ?? 0) - e.head), 0);
    assert.equal(summed, state.distance);
    assert.ok(events.some((e) => e.type === "WAIT_SKIP"));
  });

  it("请求不丢失、不重复：服务集合等于请求集合", () => {
    const requests = Array.from({ length: 20 }, (_, i) => ({
      id: `Q${i.toString().padStart(2, "0")}`,
      arrival: (i * 7) % 13,
      cylinder: (i * 3) % 11,
    }));
    const { state } = runAll(requests);
    assert.equal(state.served.length, requests.length);
    assert.equal(state.pendingIds.length, 0);
    assert.deepEqual([...state.served.map((r) => r.id)].sort(), [...requests.map((r) => r.id)].sort());
    const ids = state.served.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("等待 = 完成 - 到达，恒为非负", () => {
    const { state } = runAll([
      { id: "a", arrival: 0, cylinder: 9 },
      { id: "b", arrival: 2, cylinder: 1 },
      { id: "c", arrival: 5, cylinder: 5 },
    ]);
    for (const r of state.served) {
      assert.equal(r.wait, r.completion - r.arrival);
      assert.ok(r.wait >= 0);
    }
  });
});
