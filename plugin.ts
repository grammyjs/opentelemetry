import {
  Attributes,
  BasicTracerProvider,
  BatchSpanProcessor,
  Context,
  conventions,
  MiddlewareFn,
  otel,
  OTLPExporterNodeConfigBase,
  OTLPTraceExporter,
  RawApi,
  Resource,
  TracerConfig,
  Transformer,
  Update,
} from "./deps.ts";

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
 */
export type OpenTelemetryContext = {
  openTelemetry: {
    tracer: otel.Tracer;
    context: otel.Context;
    spanContext: otel.SpanContext;
    trace: (
      name: string,
      attributes: Attributes,
      fn: (span: otel.Span) => Promise<unknown>,
    ) => void;
  };
};

const updateType = (update: Update): string => Object.keys(update).filter((k) => k !== "update_id")[0];

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
      [conventions.SEMRESATTRS_SERVICE_NAME]: serviceName,
    }),
    ...options.providerConfig,
  });
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  provider.register();
  return provider.getTracer("grammy-otel");
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
 * import { Bot, Context } from "grammy";
 * import { openTelemetryTransformer } from "grammy-opentelemetry";
 * import { getHttpTracer } from "grammy-opentelemetry";
 *
 * const bot = new Bot<Context>("token");
 * bot.api.config.use(openTelemetryTransformer(getHttpTracer("my-bot")));
 * bot.start();
 * ```
 */
export const openTelemetryTransformer = (
  tracer: otel.Tracer,
  options: TransformerOptions = { skip: () => false },
): Transformer<RawApi> => {
  return (prev, method, payload, signal) => {
    if (options.skip(method, payload)) return prev(method, payload, signal);

    return new Promise((resolve) => {
      tracer.startActiveSpan(`api.${method}`, (span) => {
        span.addEvent("api.request", { body: JSON.stringify(payload) });
        span.setAttribute("api.method", method);
        prev(method, payload, signal)
          .then((response) => {
            span.addEvent("api.response", { body: JSON.stringify(response) });
            span.end();
            resolve(response);
          });
      });
    });
  };
};

/**
 * Options for the main middleware
 */
export type PluginOptions = {
  /**
   * Log level for OpenTelemetry diagnostics
   */
  logLevel?: otel.DiagLogLevel;
};

/**
 * Main plugin function. Enables OpenTelemetry for every update and every
 * API call performed via Context helpers (eg: ctx.reply).
 *
 * @param tracer An instance of OpenTelemetry Tracer
 * @param options Optional config object
 * @returns A middleware that enables OpenTelemetry for every update
 *
 * @example ```ts
 * import { Bot, Context } from "grammy";
 * import { openTelemetry } from "grammy-opentelemetry";
 * import { getHttpTracer } from "grammy-opentelemetry";
 *
 * const bot = new Bot<Context>("token");
 * bot.use(openTelemetry(getHttpTracer("my-bot")));
 * bot.start();
 * ```
 */
export const openTelemetry = (
  tracer: otel.Tracer,
  options: PluginOptions = {},
): MiddlewareFn<Context & OpenTelemetryContext> => {
  if (options.logLevel) {
    otel.diag.setLogger(new otel.DiagConsoleLogger(), options.logLevel);
  }

  return async (ctx, next) => {
    const rootSpan = tracer.startSpan(`update.${updateType(ctx.update)}`, {
      root: true,
    });
    let otContext = otel.trace.setSpan(otel.context.active(), rootSpan);

    ctx.api.config.use(async (prev, method, payload, signal) => {
      const apiSpan = tracer.startSpan(`api.${method}`, {}, otContext);
      apiSpan.addEvent("api.request", { body: JSON.stringify(payload) });
      apiSpan.setAttribute("api.method", method);
      const response = await prev(method, payload, signal);
      apiSpan.addEvent("api.response", { body: JSON.stringify(response) });
      apiSpan.end();
      return response;
    });

    rootSpan.setAttribute("update.type", updateType(ctx.update));
    rootSpan.setAttribute("update.body", JSON.stringify(ctx.update));

    ctx.openTelemetry = {
      spanContext: rootSpan.spanContext(),
      context: otel.trace.setSpan(otel.context.active(), rootSpan),
      tracer,
      trace: async (name, attributes, fn) => {
        const customSpan = tracer.startSpan(
          name,
          attributes,
          ctx.openTelemetry.context,
        );
        otContext = otel.trace.setSpan(otContext, customSpan);
        await fn(customSpan);
        customSpan.end();
      },
    };

    await next();
    rootSpan.end();
  };
};
