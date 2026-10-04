#!/usr/bin/env node
import { Store, defaultDbPath } from "./store";
import { startServer } from "./server";
import { runDemo } from "./demo";

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function num(args: string[], name: string): number | undefined {
  const v = argValue(args, name);
  return v === undefined ? undefined : Number(v);
}

function print(x: unknown): void {
  console.log(JSON.stringify(x, null, 2));
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const dbPath = argValue(rest, "db") ?? process.env.LOOK_DB ?? defaultDbPath();
  const store = new Store(dbPath);
  try {
    switch (cmd) {
      case "create-model": {
        const id = store.createModel({
          cylinders: num(rest, "cylinders")!,
          initialPosition: num(rest, "position")!,
          initialDirection: argValue(rest, "direction") as any,
        });
        print(store.getModel(id));
        break;
      }
      case "models":
        print(store.listModels());
        break;
      case "add-request": {
        const modelId = num(rest, "model")!;
        const file = argValue(rest, "file");
        let reqs;
        if (file) {
          reqs = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
        } else {
          reqs = [
            {
              requestId: num(rest, "id")!,
              arrival: num(rest, "arrival")!,
              cylinder: num(rest, "cylinder")!,
            },
          ];
        }
        print({ added: store.addRequests(modelId, reqs) });
        break;
      }
      case "version": {
        print(store.getModel(store.createVersion(num(rest, "model")!)));
        break;
      }
      case "run": {
        const runId = store.startRun(num(rest, "model")!, num(rest, "max-time"));
        const steps = num(rest, "steps");
        if (steps !== undefined) {
          const r = store.advance(runId, steps);
          print({ state: r.state, eventCount: r.events.length });
        } else {
          print(store.getRun(runId));
        }
        break;
      }
      case "step": {
        const r = store.advance(num(rest, "run")!, num(rest, "count") ?? 1);
        print(r);
        break;
      }
      case "status":
        print(store.getRun(num(rest, "run")!));
        break;
      case "stats":
        print(store.getStats(num(rest, "run")!));
        break;
      case "events":
        print(store.getEvents(num(rest, "run")!));
        break;
      case "requests":
        print(store.getRunRequests(num(rest, "run")!));
        break;
      case "export": {
        const data = store.exportRun(num(rest, "run")!);
        const out = argValue(rest, "out");
        if (out) {
          require("node:fs").writeFileSync(out, JSON.stringify(data, null, 2));
          console.log(`已导出到 ${out}`);
        } else {
          print(data);
        }
        break;
      }
      case "serve": {
        const port = num(rest, "port") ?? Number(process.env.PORT ?? 0);
        await startServer(store, port);
        return; // 保持进程
      }
      case "demo": {
        await runDemo(store);
        break;
      }
      default:
        console.log(`LOOK 磁头寻道仿真 CLI
用法: node dist/src/cli.js <命令> [参数] [--db 路径]
  create-model --cylinders N --position P --direction up|down
  models
  add-request --model M --id R --arrival T --cylinder C   或 --file requests.json
  version --model M                     复制为新版本（已开始运行的模型不可改）
  run --model M [--steps N] [--max-time T]
  step --run R [--count N]
  status|stats|events|requests --run R
  export --run R [--out file.json]
  serve [--port P]                      默认端口 0（自动选空闲端口）
  demo                                  运行内置演示场景`);
    }
  } finally {
    if (cmd !== "serve") store.close();
  }
}

main().catch((e) => {
  if (e && e.code) {
    console.error(`错误 [${e.code}] ${e.message}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
