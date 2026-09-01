import assert from "node:assert/strict";
import { context, type Span, type Tracer } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { openTelemetry, type PluginOptions } from "../src/plugin.ts";

type TestApiCall = (method: string, payload: unknown) => Promise<unknown>;
type TestTransformer = (prev: TestApiCall, method: string, payload: unknown) => Promise<unknown>;

function createRecordingTracer(spans: string[]): Tracer {
  const span = {
    addEvent(): void {},
    end(): void {},
    isRecording(): boolean {
      return true;
    },
    setAttribute(): void {},
  } as unknown as Span;

  return {
    startActiveSpan(name: string, callback: (span: Span) => unknown): unknown {
      spans.push(name);
      return callback(span);
    },
  } as unknown as Tracer;
}

async function callTransformer(
  method: string,
  options: Omit<PluginOptions, "tracer"> = {},
): Promise<{ result: unknown; spans: string[] }> {
  const spans: string[] = [];
  const expected = { ok: true, result: true };
  const { telemetryTransformer } = openTelemetry("test-bot", {
    ...options,
    tracer: createRecordingTracer(spans),
  });
  const result = await (telemetryTransformer as unknown as TestTransformer)(
    () => Promise.resolve(expected),
    method,
    {},
  );
  return { result, spans };
}

Deno.test("telemetryTransformer excludes getUpdates by default", async () => {
  const { result, spans } = await callTransformer("getUpdates");

  assert.deepStrictEqual(result, { ok: true, result: true });
  assert.deepStrictEqual(spans, []);
});

Deno.test("telemetryTransformer can include getUpdates", async () => {
  const { spans } = await callTransformer("getUpdates", { enableGetUpdates: true });

  assert.deepStrictEqual(spans, ["api.getUpdates"]);
});

Deno.test("telemetryTransformer applies include and exclude", async () => {
  const options: Omit<PluginOptions, "tracer"> = {
    include: (method) => method === "sendMessage" || method === "sendChatAction",
    exclude: (method) => method === "sendChatAction",
  };

  assert.deepStrictEqual((await callTransformer("sendPhoto", options)).spans, []);
  assert.deepStrictEqual((await callTransformer("sendChatAction", options)).spans, []);
  assert.deepStrictEqual((await callTransformer("sendMessage", options)).spans, ["api.sendMessage"]);
});

Deno.test("middleware context parents one API span to the update span", async () => {
  const contextManager = new AsyncLocalStorageContextManager().enable();
  const installedContextManager = context.setGlobalContextManager(contextManager);
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  const { telemetryMiddleware, telemetryTransformer } = openTelemetry("test-bot", {
    tracer: provider.getTracer("test"),
  });

  await (telemetryMiddleware as unknown as (
    ctx: object,
    next: () => Promise<void>,
  ) => Promise<void>)(
    {
      update: {
        update_id: 1,
        message: {
          message_id: 1,
          date: 0,
          chat: { id: 42, type: "private" },
        },
      },
    },
    async () => {
      await Promise.resolve();
      await (telemetryTransformer as unknown as TestTransformer)(
        () => Promise.resolve({ ok: true, result: true }),
        "sendMessage",
        {},
      );
    },
  );

  const spans = exporter.getFinishedSpans();
  const updateSpan = spans.find((span) => span.name === "update.message");
  const apiSpans = spans.filter((span) => span.name === "api.sendMessage");
  assert.ok(updateSpan);
  assert.equal(apiSpans.length, 1);
  assert.equal(apiSpans[0].parentSpanId, updateSpan.spanContext().spanId);
  await provider.shutdown();
  if (installedContextManager) context.disable();
  else contextManager.disable();
});
