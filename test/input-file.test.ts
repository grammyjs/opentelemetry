import assert from "node:assert/strict";
import type { Attributes, Span, Tracer } from "@opentelemetry/api";
import { InputFile } from "grammy";
import { openTelemetry } from "../src/plugin.ts";

type TestApiCall = (method: string, payload: unknown) => Promise<unknown>;
type TestTransformer = (prev: TestApiCall, method: string, payload: unknown) => Promise<unknown>;

const TRACE_ID = "1".repeat(32);
const SPAN_ID = "2".repeat(16);

function createRecordingSpan(events: { name: string; attributes?: Attributes }[] = []): Span {
  return {
    addEvent(name: string, attributes?: Attributes): Span {
      events.push({ name, attributes });
      return this as Span;
    },
    end(): void {},
    isRecording(): boolean {
      return true;
    },
    setAttribute(): Span {
      return this as Span;
    },
    spanContext(): { traceId: string; spanId: string; traceFlags: number } {
      return {
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: 1,
      };
    },
  } as unknown as Span;
}

function createRecordingTracer(events: { name: string; attributes?: Attributes }[] = []): Tracer {
  return {
    startActiveSpan(_name: string, callback: (span: Span) => unknown): unknown {
      return callback(createRecordingSpan(events));
    },
    startSpan(): Span {
      return createRecordingSpan(events);
    },
  } as unknown as Tracer;
}

Deno.test("telemetryTransformer forwards a top-level InputFile unchanged", async () => {
  const payload = {
    "chat_id": 42,
    document: new InputFile(new TextEncoder().encode("document"), "document.txt"),
  };
  const expected = { ok: true, result: true };
  let forwardedPayload: unknown;

  const { telemetryTransformer } = openTelemetry("test-bot", { tracer: createRecordingTracer() });
  const actual = await (telemetryTransformer as unknown as TestTransformer)(
    (_method, receivedPayload) => {
      forwardedPayload = receivedPayload;
      return Promise.resolve(expected);
    },
    "sendDocument",
    payload,
  );

  assert.strictEqual(forwardedPayload, payload);
  assert.strictEqual(actual, expected);
});

Deno.test("telemetryTransformer forwards nested InputFiles unchanged", async () => {
  const payload = {
    "chat_id": 42,
    media: [
      {
        type: "photo",
        media: new InputFile(new TextEncoder().encode("photo"), "photo.jpg"),
      },
    ],
  };
  const expected = { ok: true, result: [] };
  let forwardedPayload: unknown;

  const { telemetryTransformer } = openTelemetry("test-bot", { tracer: createRecordingTracer() });
  const actual = await (telemetryTransformer as unknown as TestTransformer)(
    (_method, receivedPayload) => {
      forwardedPayload = receivedPayload;
      return Promise.resolve(expected);
    },
    "sendMediaGroup",
    payload,
  );

  assert.strictEqual(forwardedPayload, payload);
  assert.strictEqual(actual, expected);
});

Deno.test("telemetryTransformer omits InputFiles only from the recorded request", async () => {
  const events: { name: string; attributes?: Attributes }[] = [];
  const payload = {
    "chat_id": 42,
    caption: "hello",
    media: [{ type: "photo", media: new InputFile(new Uint8Array(), "photo.jpg") }],
  };
  const expected = { ok: true, result: [] };

  const { telemetryTransformer } = openTelemetry("test-bot", { tracer: createRecordingTracer(events) });
  await (telemetryTransformer as unknown as TestTransformer)(
    () => Promise.resolve(expected),
    "sendMediaGroup",
    payload,
  );

  assert.deepStrictEqual(events, [
    {
      name: "api.request",
      attributes: { body: '{"chat_id":42,"caption":"hello","media":[{"type":"photo"}]}' },
    },
    { name: "api.response", attributes: { body: JSON.stringify(expected) } },
  ]);
});
