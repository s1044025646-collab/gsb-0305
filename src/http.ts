import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { DEFAULT_STEP_BUDGET } from "./config.js";
import { SimError } from "./errors.js";
import type { SimService } from "./service.js";
import { validateBudget, validateCreateModel, validateRequests } from "./validation.js";

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        reject(new SimError("LIMIT_EXCEEDED", "请求体超过 4MB 上限"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new SimError("BAD_REQUEST", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (params: Record<string, string>, body: unknown) => unknown | Promise<unknown>;
}

export function createHttpServer(service: SimService): Server {
  const requireVersion = (versionId: number) => {
    const version = service.store.getVersion(versionId);
    if (!version) throw new SimError("NOT_FOUND", `请求版本 ${versionId} 不存在`);
    return version;
  };

  const routes: Route[] = [
    {
      method: "GET",
      pattern: /^\/api\/limits$/,
      handler: () => ({ limits: service.limits() }),
    },
    {
      method: "POST",
      pattern: /^\/api\/models$/,
      handler: (_p, body) => {
        const input = validateCreateModel(body);
        return { model: service.createModel(input.name) };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/models$/,
      handler: () => ({ models: service.store.listModels() }),
    },
    {
      method: "GET",
      pattern: /^\/api\/models\/(\d+)$/,
      handler: (p) => {
        const modelId = Number(p[0]);
        const model = service.store.getModel(modelId);
        if (!model) throw new SimError("NOT_FOUND", `模型 ${modelId} 不存在`);
        return {
          model,
          versions: service.store.listVersions(modelId),
          runs: service.store.listRuns(modelId),
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/models\/(\d+)\/versions$/,
      handler: (p, body) => {
        const b = body as Record<string, unknown>;
        const base = validateCreateModel({
          name: "import",
          maxCylinder: b.maxCylinder,
          initialHead: b.initialHead,
          initialDirection: b.initialDirection,
        });
        const requests = validateRequests(b.requests, base.maxCylinder);
        const version = service.createVersion(
          Number(p[0]),
          base.maxCylinder,
          base.initialHead,
          base.initialDirection,
          requests,
        );
        return { version };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/versions\/(\d+)\/start$/,
      handler: (p) => service.startRun(Number(p[0])),
    },
    {
      method: "POST",
      pattern: /^\/api\/versions\/(\d+)\/step$/,
      handler: (p) => service.step(Number(p[0])),
    },
    {
      method: "POST",
      pattern: /^\/api\/versions\/(\d+)\/advance$/,
      handler: (p, body) => {
        const b = (body ?? {}) as { budget?: unknown };
        const budget = b.budget === undefined ? DEFAULT_STEP_BUDGET : validateBudget(b.budget, 0);
        return service.advance(Number(p[0]), budget);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/versions\/(\d+)$/,
      handler: (p) => ({ version: requireVersion(Number(p[0])) }),
    },
    {
      method: "GET",
      pattern: /^\/api\/versions\/(\d+)\/run$/,
      handler: (p) => {
        requireVersion(Number(p[0]));
        return { run: service.getRun(Number(p[0])) };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/versions\/(\d+)\/time$/,
      handler: (p) => {
        const run = service.getRun(Number(p[0]));
        if (!run) throw new SimError("NOT_FOUND", "运行尚未开始");
        return { time: run.time, head: run.head, direction: run.direction, status: run.status };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/versions\/(\d+)\/statistics$/,
      handler: (p) => ({ statistics: service.getStatistics(Number(p[0])) }),
    },
    {
      method: "GET",
      pattern: /^\/api\/versions\/(\d+)\/history$/,
      handler: (p) => ({ events: service.getEvents(Number(p[0])) }),
    },
    {
      method: "GET",
      pattern: /^\/api\/versions\/(\d+)\/report$/,
      handler: (p) => service.getReport(Number(p[0])),
    },
    {
      method: "GET",
      pattern: /^\/api\/versions\/(\d+)\/export$/,
      handler: (p) => {
        const result = service.exportJson(Number(p[0]));
        return { file: result.file, report: result.payload };
      },
    },
  ];

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/" || url.pathname === "/health") {
        return send(res, 200, { ok: true, service: "look-disk-sim" });
      }
      const body = req.method === "POST" ? await readJson(req) : {};
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        const params: Record<string, string> = {};
        match.slice(1).forEach((group, index) => (params[String(index)] = group));
        const result = await route.handler(params, body);
        return send(res, 200, result);
      }
      send(res, 404, {
        error: { code: "NOT_FOUND", message: `无此路由：${req.method} ${url.pathname}` },
      });
    } catch (error) {
      if (error instanceof SimError) {
        const status =
          error.code === "NOT_FOUND"
            ? 404
            : error.code === "CONFLICT" || error.code === "BUDGET_EXHAUSTED"
              ? 409
              : error.code === "LIMIT_EXCEEDED"
                ? 422
                : 400;
        return send(res, status, {
          error: { code: error.code, message: error.message, details: error.details },
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      send(res, 500, { error: { code: "INTERNAL", message } });
    }
  });

  return server;
}

/** 优先绑定指定端口；端口为 0 或被占用时回退到系统分配的空闲端口。 */
export function listenOnFreePort(server: Server, preferred?: number): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const port = preferred ?? 0;
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && preferred !== undefined && preferred !== 0) {
        server.removeListener("error", onError);
        server.listen(0, "127.0.0.1");
      } else {
        reject(err);
      }
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolvePromise((server.address() as AddressInfo).port);
    });
  });
}
