export type Direction = "up" | "down";

export interface ModelConfig {
  cylinders: number;
  initialPosition: number;
  initialDirection: Direction;
}

export interface RequestInput {
  requestId: number;
  arrival: number;
  cylinder: number;
}

export interface PendingRequest extends RequestInput {}

export interface ServedRequest extends RequestInput {
  completedAt: number;
  wait: number;
}

export type RunStatus = "running" | "paused" | "completed";

export interface RunState {
  runId: number;
  modelId: number;
  status: RunStatus;
  time: number;
  position: number;
  direction: Direction;
  totalDistance: number;
  reversals: number;
  maxTime: number;
}

export interface StepEvent {
  seq: number;
  time: number;
  type: "tick" | "idle" | "completed" | "paused";
  admitted: number[];
  served: number[];
  queueBefore: Array<{ requestId: number; cylinder: number; arrival: number }>;
  reversed: boolean;
  direction: Direction;
  from: number;
  to: number | null;
  idleFrom?: number;
  idleTo?: number;
  note?: string;
}

export const LIMITS = {
  MAX_CYLINDERS: 100000,
  MAX_REQUESTS: 100000,
  MAX_TIME: 10_000_000,
  MAX_STEPS_PER_CALL: 1_000_000,
} as const;

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function assertInt(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ApiError("INVALID_PARAM", `${name} 必须是整数`);
  }
}

export function validateModelConfig(cfg: ModelConfig): void {
  assertInt(cfg.cylinders, "cylinders");
  if (cfg.cylinders < 1 || cfg.cylinders > LIMITS.MAX_CYLINDERS) {
    throw new ApiError("INVALID_CYLINDERS", `cylinders 必须在 1..${LIMITS.MAX_CYLINDERS}`);
  }
  assertInt(cfg.initialPosition, "initialPosition");
  if (cfg.initialPosition < 0 || cfg.initialPosition >= cfg.cylinders) {
    throw new ApiError("INVALID_POSITION", "initialPosition 超出柱面范围");
  }
  if (cfg.initialDirection !== "up" && cfg.initialDirection !== "down") {
    throw new ApiError("INVALID_DIRECTION", "initialDirection 必须是 up 或 down");
  }
}

export function validateRequest(req: RequestInput, cylinders: number): void {
  assertInt(req.requestId, "requestId");
  if (req.requestId < 0) throw new ApiError("INVALID_REQUEST_ID", "requestId 不能为负");
  assertInt(req.arrival, "arrival");
  if (req.arrival < 0) throw new ApiError("INVALID_ARRIVAL", "arrival 不能为负");
  if (req.arrival > LIMITS.MAX_TIME) throw new ApiError("LIMIT_EXCEEDED", "arrival 超过最大时间");
  assertInt(req.cylinder, "cylinder");
  if (req.cylinder < 0 || req.cylinder >= cylinders) {
    throw new ApiError("INVALID_CYLINDER", "cylinder 超出柱面范围");
  }
}
