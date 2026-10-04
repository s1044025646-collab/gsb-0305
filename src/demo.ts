import { Store } from "./store";

/**
 * 演示：磁头在 5 号柱面、方向向上。
 * t=0 请求在 2 号和 7 号 → 先到 7，再反向到 2，总距离 7。
 * 另加移动途中到达的近端请求与反方向请求，展示顺序受当时队列影响。
 */
function printRun(store: Store, runId: number, title: string): void {
  const stats: any = store.getStats(runId);
  const events = store.getEvents(runId);
  console.log(`=== ${title} ===`);
  console.log("\n-- 事件序列 --");
  for (const e of events) {
    if (e.type === "tick") {
      const parts = [`t=${e.time}`, `pos ${e.from}->${e.to}`, `dir=${e.direction}`];
      if (e.admitted.length) parts.push(`到达[${e.admitted}]`);
      if (e.served.length) parts.push(`服务[${e.served}]`);
      if (e.reversed) parts.push("反向!");
      parts.push(`队列{${e.queueBefore.map((q: any) => `#${q.requestId}@${q.cylinder}`).join(",")}}`);
      console.log(parts.join("  "));
    } else {
      console.log(`t=${e.time}  [${e.type}] ${e.note ?? ""}`);
    }
  }
  console.log("\n-- 统计 --");
  console.log(`服务顺序: ${stats.serviceOrder.join(" -> ")}`);
  console.log(`总移动距离: ${stats.totalDistance}, 反向次数: ${stats.reversals}, 最终位置: ${stats.position}, 完成时刻: ${stats.time}`);
  const { served } = store.getRunRequests(runId);
  for (const s of served) {
    console.log(`  请求 #${s.requestId}: 到达 ${s.arrival}, 完成 ${s.completedAt}, 等待 ${s.wait}`);
  }
  console.log("");
}

export async function runDemo(store: Store): Promise<void> {
  // 场景一：基础演示，t=0 请求在 2、7 → 先 7 再反向到 2，总距离 7
  const m1 = store.createModel({ cylinders: 10, initialPosition: 5, initialDirection: "up" });
  store.addRequests(m1, [
    { requestId: 1, arrival: 0, cylinder: 2 },
    { requestId: 2, arrival: 0, cylinder: 7 },
  ]);
  const r1 = store.startRun(m1);
  store.advance(r1, 100);
  printRun(store, r1, "场景一：初始位置 5 方向 up，请求 #1@t0->2, #2@t0->7（期望距离 7）");

  // 场景二：移动途中到达的近端与反方向请求
  const m2 = store.createModel({ cylinders: 10, initialPosition: 5, initialDirection: "up" });
  store.addRequests(m2, [
    { requestId: 1, arrival: 0, cylinder: 2 },
    { requestId: 2, arrival: 0, cylinder: 7 },
    { requestId: 3, arrival: 1, cylinder: 6 }, // 移动途中到达的近端请求
    { requestId: 4, arrival: 3, cylinder: 0 }, // 反方向远端请求
  ]);
  const r2 = store.startRun(m2);
  store.advance(r2, 100);
  printRun(store, r2, "场景二：途中到达 #3@t1->6（近端）、#4@t3->0（反方向）");
}
