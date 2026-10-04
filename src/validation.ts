import {
  MAX_CYLINDERS,
  MAX_REQUESTS,
  MAX_STEP_BUDGET,
  MAX_TIME,
} from "./config.js";
import { SimError } from "./errors.js";
import type { Direction, RequestInput } from "./types.js";

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function validateCreateModel(body: unknown): {
  name: string;
  maxCylinder: number;
  initialHead: number;
  initialDirection: Direction;
} {
  if (typeof body !== "object" || body === null) {
    throw new SimError("BAD_REQUEST", "请求体必须为 JSON 对象");
  }
  const b = body as Record<string, unknown>;
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : undefined;
  if (!name) throw new SimError("VALIDATION", "name 必须为非空字符串", { field: "name" });

  const maxCylinder = b.maxCylinder;
  if (!isInt(maxCylinder) || maxCylinder < 1 || maxCylinder > MAX_CYLINDERS) {
    throw new SimError("VALIDATION", `maxCylinder 必须为 [1, ${MAX_CYLINDERS}] 内整数`, {
      field: "maxCylinder",
    });
  }

  const initialHead = b.initialHead;
  if (!isInt(initialHead) || initialHead < 0 || initialHead > maxCylinder) {
    throw new SimError(
      "VALIDATION",
      `initialHead 必须为 [0, ${maxCylinder}] 内整数（非整数位置非法）`,
      { field: "initialHead" },
    );
  }

  const initialDirection = b.initialDirection;
  if (initialDirection !== 1 && initialDirection !== -1) {
    throw new SimError("VALIDATION", "initialDirection 必须为 1(向上) 或 -1(向下)", {
      field: "initialDirection",
    });
  }

  return { name, maxCylinder, initialHead, initialDirection };
}

export function validateRequests(
  raw: unknown,
  maxCylinder: number,
): RequestInput[] {
  if (!Array.isArray(raw)) {
    throw new SimError("VALIDATION", "requests 必须为数组", { field: "requests" });
  }
  if (raw.length === 0) {
    throw new SimError("VALIDATION", "requests 至少包含一个请求", { field: "requests" });
  }
  if (raw.length > MAX_REQUESTS) {
    throw new SimError("LIMIT_EXCEEDED", `请求数量超过上限 ${MAX_REQUESTS}`);
  }
  const seen = new Set<string>();
  const out: RequestInput[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      throw new SimError("VALIDATION", "每个请求必须为对象");
    }
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(r.id)) {
      throw new SimError("VALIDATION", "请求 id 必须为非空字符串，仅允许字母数字、下划线与连字符", {
        field: "id",
      });
    }
    if (seen.has(r.id)) {
      throw new SimError("VALIDATION", `请求编号重复：${r.id}`, { field: "id", duplicate: r.id });
    }
    seen.add(r.id);
    if (!isInt(r.arrival) || r.arrival < 0) {
      throw new SimError("VALIDATION", `请求 ${r.id} 的 arrival 必须为非负整数（负时间非法）`, {
        field: "arrival",
        id: r.id,
      });
    }
    if (r.arrival > MAX_TIME) {
      throw new SimError("LIMIT_EXCEEDED", `请求 ${r.id} 的 arrival 超过最大时间 ${MAX_TIME}`);
    }
    if (!isInt(r.cylinder) || r.cylinder < 0 || r.cylinder > maxCylinder) {
      throw new SimError(
        "VALIDATION",
        `请求 ${r.id} 的 cylinder 必须为 [0, ${maxCylinder}] 内整数（越界非法）`,
        { field: "cylinder", id: r.id },
      );
    }
    out.push({ id: r.id, arrival: r.arrival, cylinder: r.cylinder });
  }
  return out;
}

export function validateBudget(raw: unknown, defaultValue: number): number {
  if (raw === undefined || raw === null) return defaultValue;
  if (!isInt(raw) || raw <= 0) {
    throw new SimError("VALIDATION", "budget 必须为正整数");
  }
  if (raw > MAX_STEP_BUDGET) {
    throw new SimError("LIMIT_EXCEEDED", `推进预算超过单次上限 ${MAX_STEP_BUDGET}`);
  }
  return raw;
}
