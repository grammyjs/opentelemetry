import * as otel from "@opentelemetry/api";
import type { Attributes } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { LogAttributes } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { OTLPExporterNodeConfigBase } from "@opentelemetry/otlp-exporter-base";
import { Resource } from "@opentelemetry/resources";
import { resourceFromAttributes as logResourceFromAttributes } from "@opentelemetry/resources-logs";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import type { TracerConfig } from "@opentelemetry/sdk-trace-base";
import * as conventions from "@opentelemetry/semantic-conventions";
import { InputFile } from "grammy";
import type { Context, MiddlewareFn, NextFunction, RawApi, Transformer } from "grammy";
import type { Update } from "grammy/types";

export { AlwaysOffSampler, AlwaysOnSampler, ParentBasedSampler, TraceIdRatioBasedSampler };
export type SpanDefinitions = Record<string, Attributes>;
type ValidSpanDefinitions<Spans> = { [Name in keyof Spans]: Attributes };
type SpanName<Spans> = Extract<keyof Spans, string>;
type SpanArguments<Spans> = {
  [Name in SpanName<Spans>]: [
    name: Name,
    attributes: Spans[Name],
  ];
}[SpanName<Spans>];

export type EventDefinitions = Record<string, LogAttributes>;
type ValidEventDefinitions<Events> = { [Name in keyof Events]: LogAttributes };
type EventName<Events> = Extract<keyof Events, string>;
type EventArguments<Events> = {
  [Name in EventName<Events>]: [
    name: Name,
    attributes: Events[Name],
  ];
}[EventName<Events>];

type TraceCallback = (span: otel.Span) => Promise<void>;
type TraceArguments<Spans> = {
  [Name in SpanName<Spans>]: [
    name: Name,
    attributes: Spans[Name],
    fn: TraceCallback,
  ];
}[SpanName<Spans>];

type TracedCallback<
  Spans extends ValidSpanDefinitions<Spans>,
  Events extends ValidEventDefinitions<Events>,
> = (
  ctx: Context & OpenTelemetryContext<Spans, Events>,
  span: otel.Span,
  next: NextFunction,
) => Promise<void>;
type AttributeFreeTracedArguments<
  Spans extends ValidSpanDefinitions<Spans>,
  Events extends ValidEventDefinitions<Events>,
> = {
  [Name in SpanName<Spans>]: Record<never, never> extends Spans[Name] ? [name: Name, fn: TracedCallback<Spans, Events>]
    : never;
}[SpanName<Spans>];
type AttributedTracedArguments<
  Spans extends ValidSpanDefinitions<Spans>,
  Events extends ValidEventDefinitions<Events>,
> = {
  [Name in SpanName<Spans>]: [
    name: Name,
    attributes: Spans[Name],
    fn: TracedCallback<Spans, Events>,
  ];
}[SpanName<Spans>];

type UntypedTracedCallback = (
  ctx: Context & OpenTelemetryContext,
  span: otel.Span,
  next: NextFunction,
) => Promise<void>;

/** An OpenTelemetry span that ends automatically when disposed. */
export type DisposableSpan = otel.Span & {
  [Symbol.dispose](): void;
};

const disposableSpan = (span: otel.Span): DisposableSpan => {
  let ended = false;
  const end = span.end.bind(span);
  const managed = span as DisposableSpan;
  managed.end = (endTime) => {
    if (ended) return;
    ended = true;
    end(endTime);
  };
  managed[Symbol.dispose] = () => managed.end();
  return managed;
};

/**
 * Context property added by the plugin.
 *
 * Combine this with your own context type to extend it.
 *
 * ```ts
 * import { Context } from "grammy";
 * import { OpenTelemetryContext } from "grammy-opentelemetry";
 * type MyContext = Context & OpenTelemetryContext;
 *
 * const bot = new Bot<MyContext>("token");
 * ```
 *
 * @typeParam Spans Supported custom spans and their attribute payloads
 * @typeParam Events Supported events and their attribute payloads
 */
export type OpenTelemetryContext<
  Spans extends ValidSpanDefinitions<Spans> = SpanDefinitions,
  Events extends ValidEventDefinitions<Events> = EventDefinitions,
> = {
  telemetry: {
    /**
     * An instance of OpenTelemetry Tracer
     */
    tracer: otel.Tracer;
    /**
     * The OpenTelemetry context of the current update span
     */
    context: otel.Context;
    /** The span context of the current update span. */
    spanContext: otel.SpanContext;
    /** Emit a named OpenTelemetry Log Event. */
    event: (...args: EventArguments<Events>) => void;
    /** Start a child span with a manually controlled lifetime. */
    start: (...args: SpanArguments<Spans>) => DisposableSpan;
    /**
     * Create a child span and execute a function within it
     * @param name Child span name
     * @param attributes Attributes to add to the child span
     * @param fn Function to execute within the child span
     *
     * @returns A promise that resolves when the function has finished executing
     *
     * @example
     * ```ts
     * bot.command("start", (ctx) => {
     *   return ctx.telemetry.trace(
     *     "command.start",
     *     { ["user.id"]: ctx.from?.id },
     *     async (span) => {
     *       span.addEvent("command.start.handle");
     *       await ctx.reply("Hello! I'm a bot!");
     *       await ctx.reply("I can help you with a lot of things!");
     *     },
     *   );
     * });
     * ```
     */
    trace: (...args: TraceArguments<Spans>) => Promise<void>;
  };
};

const updateType = (update: Update): string => Object.keys(update).filter((k) => k !== "update_id")[0];
const INSTRUMENTATION_SCOPE_NAME = "grammyjs-opentelemetry";
const OMIT_INPUT_FILE = Symbol("omit-input-file");

const shouldInstrumentApiCall = (
  method: Parameters<Transformer<RawApi>>["1"],
  payload: Parameters<Transformer<RawApi>>["2"],
  options: ApiInstrumentationOptions,
): boolean => {
  return (method !== "getUpdates" || options.enableGetUpdates === true) &&
    options.exclude?.(method, payload) !== true &&
    (options.include === undefined || options.include(method, payload));
};

const omitInputFiles = (value: unknown): unknown | typeof OMIT_INPUT_FILE => {
  if (value instanceof InputFile) return OMIT_INPUT_FILE;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const projected = omitInputFiles(item);
      return projected === OMIT_INPUT_FILE ? [] : [projected];
    });
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        const projected = omitInputFiles(item);
        return projected === OMIT_INPUT_FILE ? [] : [[key, projected]];
      }),
    );
  }
  return value;
};

const serializeGrammyPayload = (payload: object): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(payload).flatMap(([key, value]) => {
        const projected = omitInputFiles(value);
        return projected === OMIT_INPUT_FILE ? [] : [[key, projected]];
      }),
    ),
  );

/**
 * Create a new instance of the HTTP OpenTelemetry Tracer with recommended defaults.
 * @param serviceName Name of your bot to appear in traces
 * @param options Optional config object
 * @returns An instance of OpenTelemetry Tracer
 */
export const getHttpTracer = (
  serviceName: string,
  options: {
    exporterConfig?: OTLPExporterNodeConfigBase;
    providerConfig?: TracerConfig;
  } = { providerConfig: {} },
): otel.Tracer => {
  const exporter = new OTLPTraceExporter(options.exporterConfig);
  const provider = new BasicTracerProvider({
    resource: new Resource({
      [conventions.ATTR_SERVICE_NAME]: serviceName,
    }),
    ...options.providerConfig,
  });
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  provider.register({
    contextManager: new AsyncLocalStorageContextManager().enable(),
  });
  return provider.getTracer(INSTRUMENTATION_SCOPE_NAME);
};

type ApiFilter = (
  method: Parameters<Transformer<RawApi>>["1"],
  payload: Parameters<Transformer<RawApi>>["2"],
) => boolean;

type ApiInstrumentationOptions = {
  /**
   * Whether to instrument `getUpdates` calls. Disabled by default because
   * long polling would otherwise create a span for every polling request.
   *
   * @default false
   */
  enableGetUpdates?: boolean;
  /**
   * Instrument only API calls for which this function returns true.
   *
   * @param method The invoked API method
   * @param payload Payload of the API call
   * @returns Boolean indicating whether the API call should be included
   */
  include?: ApiFilter;
  /**
   * Do not instrument API calls for which this function returns true.
   * Takes precedence over `include`.
   *
   * @param method The invoked API method
   * @param payload Payload of the API call
   * @returns Boolean indicating whether the API call should be excluded
   */
  exclude?: ApiFilter;
};

const createTelemetryTransformer = (
  tracer: otel.Tracer,
  options: ApiInstrumentationOptions,
): Transformer<RawApi> => {
  return (prev, method, payload, signal) => {
    if (!shouldInstrumentApiCall(method, payload, options)) return prev(method, payload, signal);

    return tracer.startActiveSpan(`api.${method}`, async (span) => {
      try {
        if (span.isRecording()) {
          span.addEvent("api.request", { body: serializeGrammyPayload(payload) });
          span.setAttribute("api.method", method);
        }
        const response = await prev(method, payload, signal);
        if (span.isRecording()) {
          span.addEvent("api.response", { body: JSON.stringify(response) });
        }
        return response;
      } finally {
        span.end();
      }
    });
  };
};

/**
 * Wraps middleware in a span without initial attributes.
 * @param args Span name and middleware callback
 * @returns Middleware that runs the callback within the span
 *
 * ```ts
 * bot.command(
 *   "ping",
 *   traced("command.ping", async (ctx) => {
 *     await ctx.reply("Pong!");
 *   }),
 * );
 * ```
 */
export function traced<
  Spans extends ValidSpanDefinitions<Spans> = SpanDefinitions,
  Events extends ValidEventDefinitions<Events> = EventDefinitions,
>(...args: AttributeFreeTracedArguments<Spans, Events>): MiddlewareFn<Context & OpenTelemetryContext<Spans, Events>>;
/**
 * Wraps middleware in a span with initial attributes.
 * @param args Span name, initial attributes, and middleware callback
 * @returns Middleware that runs the callback within the span
 *
 * ```ts
 * bot.command(
 *   "finish",
 *   traced("command.finish", { success: true }, async (ctx) => {
 *     await ctx.reply("Finished!");
 *   }),
 * );
 * ```
 */
export function traced<
  Spans extends ValidSpanDefinitions<Spans> = SpanDefinitions,
  Events extends ValidEventDefinitions<Events> = EventDefinitions,
>(...args: AttributedTracedArguments<Spans, Events>): MiddlewareFn<Context & OpenTelemetryContext<Spans, Events>>;
export function traced(
  name: string,
  attributesOrFn: Attributes | UntypedTracedCallback,
  fn?: UntypedTracedCallback,
): MiddlewareFn<Context & OpenTelemetryContext> {
  return (ctx: Context & OpenTelemetryContext, next: NextFunction) => {
    if (typeof attributesOrFn === "function") {
      return ctx.telemetry.trace(name, {}, (span) => attributesOrFn(ctx, span, next));
    }
    if (fn === undefined) throw new TypeError("traced requires a callback");
    return ctx.telemetry.trace(name, attributesOrFn, (span) => fn(ctx, span, next));
  };
}

/** Configuration for `openTelemetry`. */
export type PluginOptions = ApiInstrumentationOptions & {
  /** Use an existing tracer instead of creating one for the service. */
  tracer?: otel.Tracer;
  /**
   * Log level for OpenTelemetry diagnostics
   */
  logLevel?: otel.DiagLogLevel;
};

/** Components created by `openTelemetry`. */
export type OpenTelemetry<
  Spans extends ValidSpanDefinitions<Spans> = SpanDefinitions,
  Events extends ValidEventDefinitions<Events> = EventDefinitions,
> = {
  /** Middleware that traces updates and exposes `ctx.telemetry`. */
  telemetryMiddleware: MiddlewareFn<Context & OpenTelemetryContext<Spans, Events>>;
  /** Transformer that traces outgoing Telegram API calls. */
  telemetryTransformer: Transformer<RawApi>;
};

/**
 * Creates OpenTelemetry middleware and an API transformer that share one tracer.
 *
 * @param serviceName Value of `service.name` on telemetry resources created by the plugin
 * @param options Tracer and diagnostic configuration
 * @returns Middleware and transformer components to install on the bot
 * @typeParam Spans Supported custom spans and their attribute payloads
 * @typeParam Events Supported events and their attribute payloads
 *
 * @example ```ts
 * import { Bot, Context } from "grammy";
 * import { openTelemetry, OpenTelemetryContext } from "grammy-opentelemetry";
 *
 * const bot = new Bot<Context & OpenTelemetryContext>("token");
 * const { telemetryMiddleware, telemetryTransformer } = openTelemetry("my-bot");
 * bot.use(telemetryMiddleware);
 * bot.api.config.use(telemetryTransformer);
 * bot.start();
 * ```
 */
export const openTelemetry = <
  Spans extends ValidSpanDefinitions<Spans> = SpanDefinitions,
  Events extends ValidEventDefinitions<Events> = EventDefinitions,
>(
  serviceName: string,
  options: PluginOptions = {},
): OpenTelemetry<Spans, Events> => {
  if (options.logLevel) {
    otel.diag.setLogger(new otel.DiagConsoleLogger(), options.logLevel);
  }
  const tracer = options.tracer ?? getHttpTracer(serviceName);
  const loggerProvider = logs.setGlobalLoggerProvider(
    new LoggerProvider({
      resource: logResourceFromAttributes({
        [conventions.ATTR_SERVICE_NAME]: serviceName,
      }),
      processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    }),
  );
  const logger = loggerProvider.getLogger(INSTRUMENTATION_SCOPE_NAME);

  const telemetryMiddleware: MiddlewareFn<Context & OpenTelemetryContext<Spans, Events>> = async (ctx, next) => {
    const typeKey = updateType(ctx.update);
    const rootSpan = tracer.startSpan(`update.${typeKey}`, {
      root: true,
    });
    const rootContext = otel.trace.setSpan(otel.context.active(), rootSpan);
    let otContext = rootContext;

    if (rootSpan.isRecording()) {
      rootSpan.setAttribute("update.type", typeKey);
      rootSpan.setAttribute("update.body", JSON.stringify(ctx.update));
    }

    ctx.telemetry = {
      spanContext: rootSpan.spanContext(),
      context: rootContext,
      tracer,
      event: (...args) => {
        const [eventName, attributes] = args;
        logger.emit({ eventName, attributes, context: otContext });
      },
      start: (...args) => {
        const [name, attributes] = args;
        return disposableSpan(tracer.startSpan(name, { attributes }, otContext));
      },
      trace: async (...args) => {
        const [name, attributes, fn] = args;
        const customSpan = ctx.telemetry.start(name, attributes);
        const parentContext = otContext;
        otContext = otel.trace.setSpan(parentContext, customSpan);
        try {
          await otel.context.with(otContext, () => fn(customSpan));
        } finally {
          otContext = parentContext;
          customSpan.end();
        }
      },
    };

    try {
      await otel.context.with(rootContext, next);
    } finally {
      rootSpan.end();
    }
  };
  return {
    telemetryMiddleware,
    telemetryTransformer: createTelemetryTransformer(tracer, options),
  };
};
