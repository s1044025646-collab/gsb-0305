#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runDemo } from "./demo.js";
import { createHttpServer, listenOnFreePort } from "./http.js";
import { SimError } from "./errors.js";
import { Store } from "./store.js";
import { SimService } from "./service.js";
import { validateBudget, validateCreateModel, validateRequests } from "./validation.js";

function usage(): void {
  console.log(`LOOK 磁盘寻道仿真 — 命令行用法：

  npm start -- serve [--port 8080] [--data data]
      启动 HTTP API（默认使用系统选择的空闲端口，可用 LOOK_DATA_DIR 指定数据目录）

  npm start -- demo
      运行内置演示场景并打印事件表

  npm start -- create-model --name 名称 [--data data]
  npm start -- create-version --model 1 --max-cylinder 10 --head 5 --direction 1 \\
      --requests requests.json [--data data]
  npm start -- start --version 1 [--data data]
  npm start -- step --version 1 [--data data]
  npm start -- advance --version 1 [--budget 10000] [--data data]
  npm start -- run --version 1 [--budget 10000] [--data data]   (start + 推进到完成/暂停)
  npm start -- time --version 1 [--data data]
  npm start -- stats --version 1 [--data data]
  npm start -- history --version 1 [--data data]
  npm start -- report --version 1 [--data data]
  npm start -- export --version 1 [--data data]

requests.json 示例：
  [{"id":"R2","arrival":0,"cylinder":2},{"id":"R7","arrival":0,"cylinder":7}]

约束：direction 仅允许 1(向上) / -1(向下)；时间与柱面均为非负整数；编号不可重复。`);
}

function parseArgs(argv: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        map.set(key, next);
        i++;
      } else {
        map.set(key, "true");
      }
    }
  }
  return map;
}

function intArg(map: Map<string, string>, key: string): number | undefined {
  const value = map.get(key);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new SimError("VALIDATION", `参数 --${key} 必须为整数`);
  }
  return n;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command === "demo") {
    runDemo(true);
    return;
  }

  if (command === "serve") {
    const dataDir = args.get("data");
    const port = intArg(args, "port");
    const store = new Store(dataDir);
    const service = new SimService(store);
    const server = createHttpServer(service);
    const actual = await listenOnFreePort(server, port);
    console.log(`LOOK 磁盘寻道仿真 API 已启动：http://127.0.0.1:${actual}`);
    console.log(`数据目录：${resolve(dataDir ?? process.env.LOOK_DATA_DIR ?? "data")}`);
    console.log("按 Ctrl+C 停止。");
    return;
  }

  const store = new Store(args.get("data"));
  const service = new SimService(store);
  try {
    switch (command) {
      case "create-model": {
        const name = args.get("name");
        if (!name) throw new SimError("VALIDATION", "必须提供 --name");
        const model = service.createModel(name);
        console.log(JSON.stringify(model, null, 2));
        break;
      }
      case "create-version": {
        const modelId = intArg(args, "model");
        const maxCylinder = intArg(args, "max-cylinder");
        const head = intArg(args, "head");
        const direction = intArg(args, "direction");
        const file = args.get("requests");
        if (modelId === undefined || maxCylinder === undefined || head === undefined || direction === undefined) {
          throw new SimError("VALIDATION", "必须提供 --model --max-cylinder --head --direction");
        }
        const base = validateCreateModel({ name: "cli", maxCylinder, initialHead: head, initialDirection: direction });
        if (!file) throw new SimError("VALIDATION", "必须提供 --requests requests.json");
        const raw = JSON.parse(readFileSync(resolve(file), "utf8"));
        const requests = validateRequests(raw, base.maxCylinder);
        const version = service.createVersion(modelId, base.maxCylinder, base.initialHead, base.initialDirection, requests);
        console.log(JSON.stringify(version, null, 2));
        break;
      }
      case "start": {
        const versionId = requireVersion(args);
        console.log(JSON.stringify(service.startRun(versionId), null, 2));
        break;
      }
      case "step": {
        const versionId = requireVersion(args);
        console.log(JSON.stringify(service.step(versionId), null, 2));
        break;
      }
      case "advance": {
        const versionId = requireVersion(args);
        const budget = parseBudgetArg(args);
        console.log(JSON.stringify(service.advance(versionId, budget), null, 2));
        break;
      }
      case "run": {
        const versionId = requireVersion(args);
        service.startRun(versionId);
        const budget = parseBudgetArg(args);
        const result = service.advance(versionId, budget);
        const stats = service.getStatistics(versionId);
        console.log(JSON.stringify({ result, statistics: stats }, null, 2));
        break;
      }
      case "time": {
        const versionId = requireVersion(args);
        const run = service.getRun(versionId);
        if (!run) throw new SimError("NOT_FOUND", "运行尚未开始");
        console.log(JSON.stringify({ time: run.time, head: run.head, direction: run.direction, status: run.status }, null, 2));
        break;
      }
      case "stats": {
        console.log(JSON.stringify({ statistics: service.getStatistics(requireVersion(args)) }, null, 2));
        break;
      }
      case "history": {
        console.log(JSON.stringify({ events: service.getEvents(requireVersion(args)) }, null, 2));
        break;
      }
      case "report": {
        console.log(JSON.stringify(service.getReport(requireVersion(args)), null, 2));
        break;
      }
      case "export": {
        const result = service.exportJson(requireVersion(args));
        console.log(JSON.stringify({ file: result.file }, null, 2));
        break;
      }
      default:
        usage();
        throw new SimError("BAD_REQUEST", `未知命令：${command}`);
    }
  } finally {
    store.close();
  }
}

function requireVersion(args: Map<string, string>): number {
  const versionId = intArg(args, "version");
  if (versionId === undefined) throw new SimError("VALIDATION", "必须提供 --version");
  return versionId;
}

function parseBudgetArg(args: Map<string, string>): number {
  const raw = intArg(args, "budget");
  return raw === undefined ? 10_000 : validateBudget(raw, 10_000);
}

main().catch((error: unknown) => {
  if (error instanceof SimError) {
    console.error(`错误 [${error.code}]：${error.message}`);
    if (error.details) console.error(JSON.stringify(error.details));
  } else if (error instanceof Error) {
    console.error(`错误 [INTERNAL]：${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
