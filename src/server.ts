import * as http from "node:http";
import { AddressInfo } from "node:net";
import { ApiError, LIMITS } from "./types";
import { Store } from "./store";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("INVALID_JSON", "请求体不是合法 JSON");
  }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body = method === "POST" ? await readBody(req) : {};

      if (method === "GET" && parts.length === 0) {
        return sendJson(res, 200, {
          name: "LOOK 磁头寻道仿真服务",
          endpoints: [
            "POST /models {cylinders, initialPosition, initialDirection}",
            "GET /models",
            "GET /models/:id",
            "POST /models/:id/requests {requests:[{requestId,arrival,cylinder}]}",
            "POST /models/:id/version",
            "POST /models/:id/runs {maxTime?}",
            "POST /runs/:id/step {count?}",
            "GET /runs/:id",
            "GET /runs/:id/stats",
            "GET /runs/:id/events",
            "GET /runs/:id/requests",
            "GET /runs/:id/export",
            "GET /limits",
          ],
        });
      }
      if (method === "GET" && parts[0] === "limits") {
        return sendJson(res, 200, LIMITS);
      }
      if (parts[0] === "models") {
        if (method === "POST" && parts.length === 1) {
          const id = store.createModel({
            cylinders: body.cylinders,
            initialPosition: body.initialPosition,
            initialDirection: body.initialDirection,
          });
          return sendJson(res, 201, store.getModel(id));
        }
        if (method === "GET" && parts.length === 1) {
          return sendJson(res, 200, store.listModels());
        }
        const modelId = Number(parts[1]);
        if (!Number.isInteger(modelId)) throw new ApiError("INVALID_PARAM", "模型 id 非法");
        if (method === "GET" && parts.length === 2) {
          const model = store.getModel(modelId);
          return sendJson(res, 200, { ...model, requests: store.getRequests(modelId) });
        }
        if (method === "POST" && parts[2] === "requests") {
          const added = store.addRequests(modelId, body.requests);
          return sendJson(res, 201, { added });
        }
        if (method === "POST" && parts[2] === "version") {
          const newId = store.createVersion(modelId);
          return sendJson(res, 201, store.getModel(newId));
        }
        if (method === "POST" && parts[2] === "runs") {
          const runId = store.startRun(modelId, body.maxTime);
          return sendJson(res, 201, store.getRun(runId));
        }
        if (method === "GET" && parts[2] === "runs") {
          return sendJson(res, 200, store.listRuns(modelId));
        }
      }
      if (parts[0] === "runs") {
        const runId = Number(parts[1]);
        if (!Number.isInteger(runId)) throw new ApiError("INVALID_PARAM", "运行 id 非法");
        if (method === "POST" && parts[2] === "step") {
          const result = store.advance(runId, body.count ?? 1);
          return sendJson(res, 200, result);
        }
        if (method === "GET" && parts.length === 2) return sendJson(res, 200, store.getRun(runId));
        if (method === "GET" && parts[2] === "stats") return sendJson(res, 200, store.getStats(runId));
        if (method === "GET" && parts[2] === "events") return sendJson(res, 200, store.getEvents(runId));
        if (method === "GET" && parts[2] === "requests") return sendJson(res, 200, store.getRunRequests(runId));
        if (method === "GET" && parts[2] === "export") return sendJson(res, 200, store.exportRun(runId));
      }
      throw new ApiError("NOT_FOUND", `未知路由 ${method} ${url.pathname}`, 404);
    } catch (e) {
      if (e instanceof ApiError) {
        return sendJson(res, e.status, { error: { code: e.code, message: e.message } });
      }
      sendJson(res, 500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
}

export function startServer(store: Store, port: number = 0): Promise<number> {
  const server = createServer(store);
  return new Promise((resolve) => {
    server.listen(port, () => {
      const actual = (server.address() as AddressInfo).port;
      console.log(`LOOK 仿真服务已启动: http://127.0.0.1:${actual}`);
      resolve(actual);
    });
  });
}
