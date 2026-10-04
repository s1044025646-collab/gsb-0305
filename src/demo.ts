import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { SimService } from "./service.js";

export interface DemoResult {
  versionId: number;
  report: ReturnType<SimService["getReport"]>;
  restartReport: ReturnType<SimService["getReport"]>;
  segmentedVersionId: number;
  segmentedReport: ReturnType<SimService["getReport"]>;
  newVersionId: number;
}

/**
 * 端到端演示（使用临时数据目录，可重复运行）：
 * - 磁头 5 号柱面、方向向上，零时刻请求柱面 2 与 7：先到 7 再反向到 2，总距离 7；
 * - 追加移动期间到达的近端与反方向请求，展示顺序受当时队列影响；
 * - 分段推进与一次性运行结果一致；保存重启后结果一致；旧版本报告保留。
 */
export function runDemo(verbose = true): DemoResult {
  const dataDir = mkdtempSync(join(tmpdir(), "look-demo-"));
  const store = new Store(dataDir);
  const service = new SimService(store);

  const model = service.createModel("演示-LOOK寻道");
  const requests = [
    { id: "R2", arrival: 0, cylinder: 2 },
    { id: "R7", arrival: 0, cylinder: 7 },
    { id: "R6", arrival: 1, cylinder: 6 },
    { id: "R3", arrival: 3, cylinder: 3 },
  ];
  const version = service.createVersion(model.id, 10, 5, 1, requests);
  service.startRun(version.id);
  const result = service.advance(version.id, 1000);
  if (verbose) {
    console.log("=== 场景一：5 号柱面向上，零时刻请求 2/7，移动期间 6、3 依次到达 ===");
    for (const event of result.events) console.log(event.detail);
    const stats = service.getStatistics(version.id)!;
    console.log("服务顺序：", stats.servedCount ? service.getReport(version.id).serviceOrder.map((r) => `${r.id}@t${r.completion}(等${r.wait})`).join(" → ") : "");
    console.log(
      `总移动距离 ${stats.totalDistance}，反向 ${stats.reversals} 次，最终柱面 ${stats.finalHead}，最终时刻 ${stats.currentTime}，状态 ${stats.status}`,
    );
  }
  const report = service.getReport(version.id);

  // 重启继续：重新打开同一数据库，方向/位置/队列必须原样恢复。
  store.close();
  const store2 = new Store(dataDir);
  const service2 = new SimService(store2);
  const restarted = service2.getRun(version.id);
  if (verbose) {
    console.log("\n=== 保存后重开数据库（模拟重启）===");
    console.log(
      `恢复：时刻 ${restarted?.time}，柱面 ${restarted?.head}，方向 ${restarted?.direction}，状态 ${restarted?.status}（方向未重置）`,
    );
  }
  const restartReport = service2.getReport(version.id);

  // 场景二：分段推进，每步只推一格，核对与一次性运行完全一致。
  const segModel = service2.createModel("演示-分段推进");
  const segVersion = service2.createVersion(segModel.id, 10, 5, 1, requests);
  service2.startRun(segVersion.id);
  let guard = 0;
  while (service2.getRun(segVersion.id)!.status === "running" && guard++ < 1000) {
    service2.step(segVersion.id);
  }
  const segmentedReport = service2.getReport(segVersion.id);
  if (verbose) {
    console.log("\n=== 逐周期单步推进对比 ===");
    console.log(
      `一次性运行距离 ${restartReport.statistics!.totalDistance}，单步连跑距离 ${
        segmentedReport.statistics!.totalDistance
      }；事件数 ${restartReport.events.length} vs ${segmentedReport.events.length}`,
    );
  }

  // 旧版本不可修改：为已开始模型创建新版本，旧版本报告仍保留。
  const newVersion = service2.createVersion(segModel.id, 10, 5, 1, [
    { id: "N1", arrival: 0, cylinder: 9 },
  ]);
  if (verbose) {
    console.log("\n=== 新版本创建后，旧版本报告仍保留 ===");
    console.log(
      `旧版本 v${segmentedReport.version.version} 状态 ${segmentedReport.run?.status}，新版本 v${newVersion.version} 已建立（id=${newVersion.id}）`,
    );
  }

  return {
    versionId: version.id,
    report,
    restartReport,
    segmentedVersionId: segVersion.id,
    segmentedReport,
    newVersionId: newVersion.id,
  };
}
