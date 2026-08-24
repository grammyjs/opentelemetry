import {
  Attributes,
  BasicTracerProvider,
  BatchSpanProcessor,
  Context,
  conventions,
  MiddlewareFn,
  NextFunction,
  otel,
  OTLPExporterNodeConfigBase,
  OTLPTraceExporter,
  RawApi,
  Resource,
  TracerConfig,
  Transformer,
  Update,
} from "./deps.deno.ts";

export type SpanDefinitions = Record<string, Attributes>;
type ValidSpanDefinitions<Spans> = { [Name in keyof Spans]: Attributes };
type SpanName<Spans> = Extract<keyof Spans, string>;
type TraceCallback = (span: otel.Span) => Promise<void>;
type TraceArguments<Spans> = {
  [Name in SpanName<Spans>]: [
    name: Name,
    attributes: Spans[Name],
    fn: TraceCallback,
  ];
}[SpanName<Spans>];

type TracedCallback<Spans extends ValidSpanDefinitions<Spans>> = (
  ctx: Context & OpenTelemetryContext<Spans>,
  span: otel.Span,
  next: NextFunction,
) => Promise<void>;
type AttributeFreeTracedArguments<Spans extends ValidSpanDefinitions<Spans>> = {
  [Name in SpanName<Spans>]: Record<never, never> extends Spans[Name] ? [name: Name, fn: TracedCallback<Spans>]
    : never;
}[SpanName<Spans>];
type AttributedTracedArguments<Spans extends ValidSpanDefinitions<Spans>> = {
  [Name in SpanName<Spans>]: [
    name: Name,
    attributes: Spans[Name],
    fn: TracedCallback<Spans>,
  ];
}[SpanName<Spans>];

type UntypedTracedCallback = (
  ctx: Context & OpenTelemetryContext,
  span: otel.Span,
  next: NextFunction,
) => Promise<void>;

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
 */
export type OpenTelemetryContext<
  Spans extends ValidSpanDefinitions<Spans> = SpanDefinitions,
> = {
  telemetry: {
    /**
     * An instance of OpenTelemetry Tracer
     */
    tracer: otel.Tracer;
    /**
     * The current active OpenTelemetry context
     */
    context: otel.Context;
    /**
     * The current active OpenTelemetry span context
     */
    spanContext: otel.SpanContext;
    /**
     * Create a new span and execute a function within it
     * @param name Name of the span
     * @param attributes Attributes to add to the span
     * @param fn Function to execute within the span
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
  provider.register();
  return provider.getTracer(INSTRUMENTATION_SCOPE_NAME);
};

/**
 * Options for the transformer middleware
 */
export type TransformerOptions = {
  /**
   * A function that returns true if the given method and payload should be skipped
   * @param method The invoked API method
   * @param payload Payload of the API call
   * @returns Boolean indicating whether the API call should be skipped
   */
  skip: (method: Parameters<Transformer<RawApi>>["1"], payload: Parameters<Transformer<RawApi>>["2"]) => boolean;
};

/**
 * Enables telemetry for every API call made outside of a middleware or
 * by using `bot.api` directly.
 *
 * @param tracer An instance of OpenTelemetry Tracer
 * @param options Optional config object
 *
 * @example ```ts
 * bot.api.config.use(openTelemetryTransformer(getHttpTracer("my-bot")));
 * ```
 */
export const openTelemetryTransformer = (
  tracer: otel.Tracer,
  options: TransformerOptions = { skip: () => false },
): Transformer<RawApi> => {
  return (prev, method, payload, signal) => {
    if (options.skip(method, payload)) return prev(method, payload, signal);

    return tracer.startActiveSpan(`api.${method}`, async (span) => {
      try {
        span.addEvent("api.request", { body: JSON.stringify(payload) });
        span.setAttribute("api.method", method);
        const response = await prev(method, payload, signal);
        span.addEvent("api.response", { body: JSON.stringify(response) });
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
export function traced<Spans extends ValidSpanDefinitions<Spans> = SpanDefinitions>(
  ...args: AttributeFreeTracedArguments<Spans>
): MiddlewareFn<Context & OpenTelemetryContext<Spans>>;
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
export function traced<Spans extends ValidSpanDefinitions<Spans> = SpanDefinitions>(
  ...args: AttributedTracedArguments<Spans>
): MiddlewareFn<Context & OpenTelemetryContext<Spans>>;
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

/**
 * Options for the main middleware
 */
export type PluginOptions = {
  /** Use an existing tracer instead of creating one for the service. */
  tracer?: otel.Tracer;
  /**
   * Log level for OpenTelemetry diagnostics
   */
  logLevel?: otel.DiagLogLevel;
};

/**
 * Main plugin function. Enables OpenTelemetry for every update and every
 * API call performed via Context helpers (eg: ctx.reply).
 *
 * @param serviceName Value of `service.name` on telemetry resources created by the plugin
 * @param options Tracer and diagnostic configuration
 * @returns A middleware that enables OpenTelemetry for every update
 * @typeParam Spans Supported custom spans and their attribute payloads
 *
 * @example ```ts
 * import { Bot, Context } from "grammy";
 * import { openTelemetry } from "grammy-opentelemetry";
 *
 * const bot = new Bot<Context>("token");
 * bot.use(openTelemetry("my-bot"));
 * bot.start();
 * ```
 */
export const openTelemetry = <
  Spans extends ValidSpanDefinitions<Spans> = SpanDefinitions,
>(
  serviceName: string,
  options: PluginOptions = {},
): MiddlewareFn<Context & OpenTelemetryContext<Spans>> => {
  if (options.logLevel) {
    otel.diag.setLogger(new otel.DiagConsoleLogger(), options.logLevel);
  }
  const tracer = options.tracer ?? getHttpTracer(serviceName);

  return async (ctx, next) => {
    const rootSpan = tracer.startSpan(`update.${updateType(ctx.update)}`, {
      root: true,
    });
    const rootContext = otel.trace.setSpan(otel.context.active(), rootSpan);
    let otContext = rootContext;

    ctx.api.config.use(async (prev, method, payload, signal) => {
      const apiSpan = tracer.startSpan(`api.${method}`, {}, otContext);
      try {
        apiSpan.addEvent("api.request", { body: JSON.stringify(payload) });
        apiSpan.setAttribute("api.method", method);
        const response = await prev(method, payload, signal);
        apiSpan.addEvent("api.response", { body: JSON.stringify(response) });
        return response;
      } finally {
        apiSpan.end();
      }
    });

    rootSpan.setAttribute("update.type", updateType(ctx.update));
    rootSpan.setAttribute("update.body", JSON.stringify(ctx.update));

    ctx.telemetry = {
      spanContext: rootSpan.spanContext(),
      context: rootContext,
      tracer,
      trace: async (name, attributes, fn) => {
        const customSpan = tracer.startSpan(name, { attributes }, otContext);
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
};
