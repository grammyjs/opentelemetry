import assert from "node:assert/strict";
import test from "node:test";

import grammy from "grammy";
import plugin from "../out/plugin.js";

const { InputFile } = grammy;
const { openTelemetry, openTelemetryTransformer } = plugin;

const TRACE_ID = "1".repeat(32);
const SPAN_ID = "2".repeat(16);

function createRecordingSpan() {
  return {
    addEvent() {},
    end() {},
    isRecording() {
      return true;
    },
    setAttribute() {},
    spanContext() {
      return {
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: 1,
      };
    },
  };
}

function createRecordingTracer() {
  return {
    startActiveSpan(_name, callback) {
      return callback(createRecordingSpan());
    },
    startSpan() {
      return createRecordingSpan();
    },
  };
}

test("openTelemetryTransformer forwards a top-level InputFile unchanged", async () => {
  const payload = {
    chat_id: 42,
    document: new InputFile(Buffer.from("document"), "document.txt"),
  };
  const expected = { ok: true, result: true };
  let forwardedPayload;

  const transformer = openTelemetryTransformer(createRecordingTracer());
  const actual = await transformer(
    async (_method, receivedPayload) => {
      forwardedPayload = receivedPayload;
      return expected;
    },
    "sendDocument",
    payload,
  );

  assert.strictEqual(forwardedPayload, payload);
  assert.strictEqual(actual, expected);
});

test("openTelemetry middleware forwards nested InputFiles unchanged", async () => {
  const payload = {
    chat_id: 42,
    media: [
      {
        type: "photo",
        media: new InputFile(Buffer.from("photo"), "photo.jpg"),
      },
    ],
  };
  const expected = { ok: true, result: [] };
  const transformers = [];
  let forwardedPayload;
  let actual;

  const ctx = {
    api: {
      config: {
        use(transformer) {
          transformers.push(transformer);
        },
      },
    },
    update: {
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 42, type: "private" },
      },
    },
  };

  const middleware = openTelemetry("test-bot", {
    tracer: createRecordingTracer(),
  });

  await middleware(ctx, async () => {
    assert.equal(transformers.length, 1);
    actual = await transformers[0](
      async (_method, receivedPayload) => {
        forwardedPayload = receivedPayload;
        return expected;
      },
      "sendMediaGroup",
      payload,
    );
  });

  assert.strictEqual(forwardedPayload, payload);
  assert.strictEqual(actual, expected);
});
