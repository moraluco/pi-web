// Bridge between the @eko24ive/pi-ask "remote ask" event protocol and the
// Pi Web frontend. pi-ask emits structured ask-flow events on the extension
// event bus (started/completed) and resolves them via submit/submit-result
// round trips. This module forwards those events to web clients as agent
// events and routes their answers back onto the bus.
//
// pi-ask only starts flows in non-TUI mode when PI_ASK_REMOTE_ONLY=1 is set
// (see instrumentation.ts).

import { randomUUID } from "crypto";
import type {
  AskUserQuestion,
  AskUserSubmitResponse,
  AskUserSubmitResult,
} from "./types";

export type {
  AskUserAnswer,
  AskUserOption,
  AskUserQuestion,
  AskUserSubmitResponse,
  AskUserSubmitResult,
} from "./types";

export const PI_ASK_STARTED_EVENT = "@eko24ive/pi-ask:started";
export const PI_ASK_COMPLETED_EVENT = "@eko24ive/pi-ask:completed";
export const PI_ASK_SUBMIT_EVENT = "@eko24ive/pi-ask:submit";
export const PI_ASK_SUBMIT_RESULT_EVENT = "@eko24ive/pi-ask:submit-result";

const SUBMIT_TIMEOUT_MS = 15_000;

export interface AskUserStartedPayload {
  version: 1;
  flowId: string;
  toolCallId?: string;
  source: string;
  title?: string;
  questions: AskUserQuestion[];
  createdAt: number;
}

export interface AskUserEventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

type EmitFn = (event: Record<string, unknown>) => void;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseStartedPayload(data: unknown): AskUserStartedPayload | null {
  if (!isPlainObject(data)) return null;
  if (typeof data.flowId !== "string" || !data.flowId) return null;
  if (!Array.isArray(data.questions)) return null;
  return data as unknown as AskUserStartedPayload;
}

/**
 * One bridge per agent session: the session's extension event bus is the
 * source of truth for ask flows owned by that session.
 */
export class AskUserBridge {
  private readonly bus: AskUserEventBusLike;
  private readonly emitEvent: EmitFn;
  private readonly flows = new Map<string, AskUserStartedPayload>();
  private readonly pendingSubmits = new Map<string, {
    resolve: (result: AskUserSubmitResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly unsubscribes: Array<() => void>;

  constructor(bus: AskUserEventBusLike, emitEvent: EmitFn) {
    this.bus = bus;
    this.emitEvent = emitEvent;
    this.unsubscribes = [
      bus.on(PI_ASK_STARTED_EVENT, (data) => this.handleStarted(data)),
      bus.on(PI_ASK_COMPLETED_EVENT, (data) => this.handleCompleted(data)),
      bus.on(PI_ASK_SUBMIT_RESULT_EVENT, (data) => this.handleSubmitResult(data)),
    ];
  }

  /** Events for flows still waiting on an answer, replayed to (re)connected clients. */
  getPendingEvents(): Array<Record<string, unknown>> {
    return [...this.flows.values()].map((payload) => ({
      type: "ask_user_request",
      ...payload,
    }));
  }

  hasFlow(flowId: string): boolean {
    return this.flows.has(flowId);
  }

  /** Forward a web client's answer/cancel to pi-ask and await its validation result. */
  submit(flowId: string, response: AskUserSubmitResponse): Promise<AskUserSubmitResult> {
    if (!this.flows.has(flowId)) {
      return Promise.resolve({
        ok: false,
        error: "flow_not_found",
        message: "Ask flow is not active.",
      });
    }
    const requestId = randomUUID();
    return new Promise<AskUserSubmitResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSubmits.delete(requestId);
        resolve({ ok: false, error: "timeout", message: "Timed out waiting for pi-ask." });
      }, SUBMIT_TIMEOUT_MS);
      this.pendingSubmits.set(requestId, { resolve, timer });
      this.bus.emit(PI_ASK_SUBMIT_EVENT, { version: 1, requestId, flowId, response });
    });
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    for (const [requestId, pending] of this.pendingSubmits) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "disposed", message: "Session ended." });
      this.pendingSubmits.delete(requestId);
    }
    this.flows.clear();
  }

  private handleStarted(data: unknown): void {
    const payload = parseStartedPayload(data);
    if (!payload) return;
    this.flows.set(payload.flowId, payload);
    this.emitEvent({ type: "ask_user_request", ...payload });
  }

  private handleCompleted(data: unknown): void {
    if (!isPlainObject(data) || typeof data.flowId !== "string") return;
    this.flows.delete(data.flowId);
    this.emitEvent({
      type: "ask_user_closed",
      flowId: data.flowId,
      ...(isPlainObject(data.result) ? { result: data.result } : {}),
    });
  }

  private handleSubmitResult(data: unknown): void {
    if (!isPlainObject(data) || typeof data.requestId !== "string") return;
    const pending = this.pendingSubmits.get(data.requestId);
    if (!pending) return;
    this.pendingSubmits.delete(data.requestId);
    clearTimeout(pending.timer);
    if (data.ok === true) {
      pending.resolve({ ok: true });
    } else {
      pending.resolve({
        ok: false,
        error: typeof data.error === "string" ? data.error : "invalid_request",
        message: typeof data.message === "string" ? data.message : "Submit failed.",
      });
    }
  }
}
