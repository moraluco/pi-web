import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./ask-user-bridge.ts");
}

class MockBus {
  emitted = [];
  handlers = new Map();

  emit(channel, data) {
    this.emitted.push({ channel, data });
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }

  on(channel, handler) {
    const handlers = this.handlers.get(channel) ?? [];
    handlers.push(handler);
    this.handlers.set(channel, handlers);
    return () => {
      this.handlers.set(
        channel,
        (this.handlers.get(channel) ?? []).filter((candidate) => candidate !== handler),
      );
    };
  }
}

function startedPayload(flowId = "tool:call-1") {
  return {
    version: 1,
    flowId,
    toolCallId: "call-1",
    source: "tool",
    title: "Pick one",
    questions: [
      {
        id: "q1",
        label: "Q1",
        prompt: "Choose",
        type: "single",
        required: true,
        options: [{ value: "a", label: "A" }],
      },
    ],
    createdAt: Date.now(),
  };
}

test("forwards started flows to clients and replays pending ones", async () => {
  const { AskUserBridge, PI_ASK_STARTED_EVENT } = await loadSubject();
  const bus = new MockBus();
  const events = [];
  const bridge = new AskUserBridge(bus, (event) => events.push(event));

  bus.emit(PI_ASK_STARTED_EVENT, startedPayload());

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "ask_user_request");
  assert.equal(events[0].flowId, "tool:call-1");
  assert.equal(bridge.getPendingEvents().length, 1);
  assert.equal(bridge.getPendingEvents()[0].type, "ask_user_request");
  assert.equal(bridge.hasFlow("tool:call-1"), true);
  bridge.dispose();
});

test("completed flows close the client dialog and stop replaying", async () => {
  const { AskUserBridge, PI_ASK_STARTED_EVENT, PI_ASK_COMPLETED_EVENT } = await loadSubject();
  const bus = new MockBus();
  const events = [];
  const bridge = new AskUserBridge(bus, (event) => events.push(event));

  bus.emit(PI_ASK_STARTED_EVENT, startedPayload());
  bus.emit(PI_ASK_COMPLETED_EVENT, {
    version: 1,
    flowId: "tool:call-1",
    source: "tool",
    result: { cancelled: false },
    completedAt: Date.now(),
  });

  assert.equal(events.length, 2);
  assert.equal(events[1].type, "ask_user_closed");
  assert.equal(events[1].flowId, "tool:call-1");
  assert.equal(bridge.getPendingEvents().length, 0);
  assert.equal(bridge.hasFlow("tool:call-1"), false);
  bridge.dispose();
});

test("submit round trip resolves with the pi-ask validation result", async () => {
  const {
    AskUserBridge,
    PI_ASK_STARTED_EVENT,
    PI_ASK_SUBMIT_EVENT,
    PI_ASK_SUBMIT_RESULT_EVENT,
  } = await loadSubject();
  const bus = new MockBus();
  const bridge = new AskUserBridge(bus, () => {});

  bus.emit(PI_ASK_STARTED_EVENT, startedPayload());
  const promise = bridge.submit("tool:call-1", {
    kind: "answer",
    answers: { q1: { values: ["a"] } },
  });

  const submit = bus.emitted.find((entry) => entry.channel === PI_ASK_SUBMIT_EVENT);
  assert.ok(submit);
  const submitData = submit.data;
  assert.equal(submitData.flowId, "tool:call-1");
  assert.equal(submitData.version, 1);

  bus.emit(PI_ASK_SUBMIT_RESULT_EVENT, {
    version: 1,
    requestId: submitData.requestId,
    flowId: "tool:call-1",
    ok: true,
  });
  assert.deepEqual(await promise, { ok: true });
  bridge.dispose();
});

test("submit surfaces validation errors from pi-ask", async () => {
  const {
    AskUserBridge,
    PI_ASK_STARTED_EVENT,
    PI_ASK_SUBMIT_EVENT,
    PI_ASK_SUBMIT_RESULT_EVENT,
  } = await loadSubject();
  const bus = new MockBus();
  const bridge = new AskUserBridge(bus, () => {});

  bus.emit(PI_ASK_STARTED_EVENT, startedPayload());
  const promise = bridge.submit("tool:call-1", { kind: "answer", answers: {} });
  const submit = bus.emitted.find((entry) => entry.channel === PI_ASK_SUBMIT_EVENT);
  const requestId = submit?.data.requestId;

  bus.emit(PI_ASK_SUBMIT_RESULT_EVENT, {
    version: 1,
    requestId,
    flowId: "tool:call-1",
    ok: false,
    error: "invalid_answer",
    message: "Unknown option value.",
  });

  assert.deepEqual(await promise, {
    ok: false,
    error: "invalid_answer",
    message: "Unknown option value.",
  });
  bridge.dispose();
});

test("submit rejects unknown flows without touching the bus", async () => {
  const { AskUserBridge, PI_ASK_SUBMIT_EVENT } = await loadSubject();
  const bus = new MockBus();
  const bridge = new AskUserBridge(bus, () => {});

  const result = await bridge.submit("tool:missing", { kind: "cancel" });
  assert.equal(result.ok, false);
  assert.equal(bus.emitted.some((entry) => entry.channel === PI_ASK_SUBMIT_EVENT), false);
  bridge.dispose();
});

test("dispose resolves in-flight submits", async () => {
  const { AskUserBridge, PI_ASK_STARTED_EVENT } = await loadSubject();
  const bus = new MockBus();
  const bridge = new AskUserBridge(bus, () => {});

  bus.emit(PI_ASK_STARTED_EVENT, startedPayload());
  const promise = bridge.submit("tool:call-1", { kind: "cancel" });
  bridge.dispose();
  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.error, "disposed");
});

test("malformed started payloads are ignored", async () => {
  const { AskUserBridge, PI_ASK_STARTED_EVENT } = await loadSubject();
  const bus = new MockBus();
  const events = [];
  const bridge = new AskUserBridge(bus, (event) => events.push(event));

  bus.emit(PI_ASK_STARTED_EVENT, null);
  bus.emit(PI_ASK_STARTED_EVENT, { flowId: 42 });
  bus.emit(PI_ASK_STARTED_EVENT, { flowId: "x" });

  assert.equal(events.length, 0);
  assert.equal(bridge.getPendingEvents().length, 0);
  bridge.dispose();
});
