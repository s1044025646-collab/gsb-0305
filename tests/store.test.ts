import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SimError } from "../src/errors.js";
import { runDemo } from "../src/demo.js";
import { Store } from "../src/store.js";
import { SimService } from "../src/service.js";
import { validateBudget, validateCreateModel, validateRequests } from "../src/validation.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "look-test-"));
}

describe("SQLite 持久化与重启", () => {
  it("分段推进后重开数据库，状态、方向、事件、统计完全一致", () => {
    const dataDir = tempDir();
    const requests = [
      { id: "R2", arrival: 0, cylinder: 2 },
      { id: "R7", arrival: 0, cylinder: 7 },
      { id: "R6", arrival: 1, cylinder: 6 },
      { id: "R3", arrival: 3, cylinder: 3 },
    ];

    let store = new Store(dataDir);
    let service = new SimService(store);
    const model = service.createModel("persist");
    const version = service.createVersion(model.id, 10, 5, 1, requests);
    service.startRun(version.id);
    for (let i = 0; i < 4; i++) service.step(version.id);
    const midRun = service.getRun(version.id)!;
    const midEvents = service.getEvents(version.id);
    const midSnapshot = JSON.stringify({ midRun, midEvents });
    assert.equal(midRun.direction, -1);
    assert.equal(midRun.distance, 4);
    store.close();

    const store2 = new Store(dataDir);
    const service2 = new SimService(store2);
    const resumedRun = service2.getRun(version.id)!;
    const resumedEvents = service2.getEvents(version.id);
    assert.equal(JSON.stringify({ midRun: resumedRun, midEvents: resumedEvents }), midSnapshot);

    service2.advance(version.id, 100_000);
    const fullStats = service2.getStatistics(version.id)!;
    assert.equal(fullStats.status, "complete");
    assert.equal(fullStats.totalDistance, 7);
    assert.equal(resumedRun.direction, -1);
    store2.close();

    // 再次重开：完成态与全部历史仍在。
    const store3 = new Store(dataDir);
    const service3 = new SimService(store3);
    const finalRun = service3.getRun(version.id)!;
    assert.equal(finalRun.status, "complete");
    assert.equal(finalRun.direction, -1);
    assert.ok(service3.getEvents(version.id).length >= resumedEvents.length);
    store3.close();
  });

  it("已开始的到达表不可原地修改，新版本保留旧报告", () => {
    const dataDir = tempDir();
    const store = new Store(dataDir);
    const service = new SimService(store);
    const model = service.createModel("immutable");
    const v1 = service.createVersion(model.id, 10, 5, 1, [
      { id: "A", arrival: 0, cylinder: 9 },
    ]);
    service.startRun(v1.id);
    service.advance(v1.id, 100);
    assert.throws(
      () => service.store.assertVersionNotStarted(v1.id),
      (err: unknown) => err instanceof SimError && err.code === "CONFLICT",
    );
    const v2 = service.createVersion(model.id, 10, 5, 1, [
      { id: "B", arrival: 0, cylinder: 1 },
    ]);
    assert.notEqual(v2.id, v1.id);
    assert.equal(service.getRun(v1.id)!.status, "complete");
    assert.equal(service.getStatistics(v1.id)!.servedCount, 1);
    assert.equal(service.getRun(v2.id), null);
    store.close();
  });

  it("内置演示：一次性运行与逐周期单步结果一致，重启报告一致", () => {
    const result = runDemo(false);
    assert.equal(result.report.statistics!.totalDistance, result.segmentedReport.statistics!.totalDistance);
    assert.equal(result.report.events.length, result.segmentedReport.events.length);
    assert.deepEqual(
      result.report.run!.served.map((r) => r.id),
      result.segmentedReport.run!.served.map((r) => r.id),
    );
    assert.deepEqual(result.restartReport.run, result.report.run);
  });

  it("JSON 导出落盘且内容可读回", () => {
    const store = new Store(tempDir());
    const service = new SimService(store);
    const model = service.createModel("export");
    const version = service.createVersion(model.id, 10, 5, 1, [
      { id: "A", arrival: 0, cylinder: 7 },
    ]);
    service.startRun(version.id);
    service.advance(version.id, 100);
    const { file } = service.exportJson(version.id);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(parsed.statistics.totalDistance, 2);
    assert.equal(parsed.version.requests.length, 1);
    store.close();
  });
});

describe("参数校验与错误码", () => {
  const validBody = { name: "m", maxCylinder: 10, initialHead: 5, initialDirection: 1 };

  it("非法方向、非整数位置、越界柱面、负时间、重复编号均被拒绝", () => {
    assert.throws(() => validateCreateModel({ ...validBody, initialDirection: 0 }), SimError);
    assert.throws(() => validateCreateModel({ ...validBody, initialHead: 1.5 }), SimError);
    assert.throws(() => validateCreateModel({ ...validBody, initialHead: 11 }), SimError);
    assert.throws(() => validateRequests([{ id: "x", arrival: -1, cylinder: 1 }], 10), SimError);
    assert.throws(
      () =>
        validateRequests(
          [
            { id: "x", arrival: 0, cylinder: 1 },
            { id: "x", arrival: 1, cylinder: 2 },
          ],
          10,
        ),
      (err: unknown) => err instanceof SimError && err.code === "VALIDATION",
    );
    assert.throws(() => validateRequests([{ id: "x", arrival: 0, cylinder: 11 }], 10), SimError);
  });

  it("预算必须为正整数且不超过单次上限", () => {
    assert.equal(validateBudget(undefined, 42), 42);
    assert.throws(() => validateBudget(0, 42), SimError);
    assert.throws(() => validateBudget(2_000_000, 42), SimError);
  });
});
