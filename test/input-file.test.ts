import assert from "node:assert/strict";
import type { Span, Tracer } from "@opentelemetry/api";
import { InputFile } from "grammy";
import { openTelemetry, openTelemetryTransformer } from "../src/plugin.ts";

type TestApiCall = (method: string, payload: unknown) => Promise<unknown>;
type TestTransformer = (prev: TestApiCall, method: string, payload: unknown) => Promise<unknown>;
type TestContext = {
  api: {
    config: {
      use(transformer: TestTransformer): void;
    };
  };
  update: {
    "update_id": number;
    message: {
      "message_id": number;
      date: number;
      chat: { id: number; type: "private" };
    };
  };
};
type TestMiddleware = (ctx: TestContext, next: () => Promise<void>) => Promise<void>;

const TRACE_ID = "1".repeat(32);
const SPAN_ID = "2".repeat(16);

function createRecordingSpan(): Span {
  return {
    addEvent(): void {},
    end(): void {},
    isRecording(): boolean {
      return true;
    },
    setAttribute(): void {},
    spanContext(): { traceId: string; spanId: string; traceFlags: number } {
      return {
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: 1,
      };
    },
  } as unknown as Span;
}

function createRecordingTracer(): Tracer {
  return {
    startActiveSpan(_name: string, callback: (span: Span) => unknown): unknown {
      return callback(createRecordingSpan());
    },
    startSpan(): Span {
      return createRecordingSpan();
    },
  } as unknown as Tracer;
}

Deno.test("openTelemetryTransformer forwards a top-level InputFile unchanged", async () => {
  const payload = {
    "chat_id": 42,
    document: new InputFile(new TextEncoder().encode("document"), "document.txt"),
  };
  const expected = { ok: true, result: true };
  let forwardedPayload: unknown;

  const transformer = openTelemetryTransformer(createRecordingTracer()) as unknown as TestTransformer;
  const actual = await transformer(
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

Deno.test("openTelemetry middleware forwards nested InputFiles unchanged", async () => {
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
  const transformers: TestTransformer[] = [];
  let forwardedPayload: unknown;
  let actual: unknown;

  const ctx: TestContext = {
    api: {
      config: {
        use(transformer): void {
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
  }) as unknown as TestMiddleware;

  await middleware(ctx, async () => {
    assert.equal(transformers.length, 1);
    actual = await transformers[0](
      (_method, receivedPayload) => {
        forwardedPayload = receivedPayload;
        return Promise.resolve(expected);
      },
      "sendMediaGroup",
      payload,
    );
  });

  assert.strictEqual(forwardedPayload, payload);
  assert.strictEqual(actual, expected);
});
