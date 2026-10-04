export type Direction = 1 | -1;

export interface RequestInput {
  id: string;
  arrival: number;
  cylinder: number;
}

export interface ServedRequest extends RequestInput {
  completion: number;
  wait: number;
}

export type RunStatus = "idle" | "running" | "paused" | "complete";

export interface RunState {
  runId: number;
  versionId: number;
  time: number;
  head: number;
  direction: Direction;
  distance: number;
  reversals: number;
  status: RunStatus;
  pendingIds: string[];
  served: ServedRequest[];
  nextArrivalIndex: number;
}

export type EventType =
  | "ARRIVALS"
  | "SERVICE"
  | "WAIT_SKIP"
  | "REVERSE"
  | "MOVE"
  | "COMPLETE"
  | "PAUSED";

export interface SimEvent {
  seq: number;
  time: number;
  type: EventType;
  head: number;
  direction: Direction;
  detail: string;
  requestIds?: string[];
  queueIds?: string[];
  nextHead?: number;
  reversed?: boolean;
  distanceDelta?: number;
}

export interface StepResult {
  state: RunState;
  events: SimEvent[];
  budgetLeft: number;
}

export interface VersionSnapshot {
  id: number;
  modelId: number;
  version: number;
  maxCylinder: number;
  initialHead: number;
  initialDirection: Direction;
  requests: RequestInput[];
  started: boolean;
  createdAt: string;
}
