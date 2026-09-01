# grammY OpenTelemetry

Integrates OpenTelemetry into grammY.

Development is in progress.

## Description

After a lot of thought and research, we came to the conclusion that it would be bad to integrate with a particular
technology, especially if it is possible to support many at once. Fortunately, there is the OpenTelemetry project, which
defines a single approach to collecting and managing telemetry that integrates perfectly with many existing services.
However, there are some problems with it:

1. The JS toolkit is quite young, so many things are experimental or just under development, which makes it difficult to
   use.
2. They split the Web and Node.js tools into separate packages, which will cause support issues in the future.
3. They are very fond of autoinstrumentation, which intercepts `require/import` calls and patches the requested package,
   which we think is a very, very bad pattern that we don't want to impose on grammY users.

This plugin allows you to use OpenTelemetry without those caveats.

## Installation

Node.js:

```sh
npm install grammy @grammyjs/opentelemetry
```

Deno:

```sh
deno add npm:grammy npm:@grammyjs/opentelemetry
```

## Setup

```ts
import { Bot, type Context } from "grammy";
import { openTelemetry, type OpenTelemetryContext, traced } from "@grammyjs/opentelemetry";

const bot = new Bot<Context & OpenTelemetryContext>("token");
const { telemetryMiddleware, telemetryTransformer } = openTelemetry("my-bot");
bot.use(telemetryMiddleware);
bot.api.config.use(telemetryTransformer);
```

To use a custom tracer:

```ts
const { telemetryMiddleware, telemetryTransformer } = openTelemetry("my-bot", { tracer: customTracer });
```

## API calls

The API transformer traces calls through `bot.api`, `ctx.api`, and Context helpers such as `ctx.reply()`.

```ts
const { telemetryTransformer } = openTelemetry("my-bot", {
  enableGetUpdates: true, // getUpdates is disabled by default
  exclude: (method) => method === "sendChatAction", // Exclude matching methods, track the rest
  include: (method) => method === "sendMessage", // or Include only matching methods
});
bot.api.config.use(telemetryTransformer);
```

## Events

`event()` emits an OpenTelemetry Log Event:

```ts
bot.command("start", (ctx) => {
  ctx.telemetry.event("command.start", { "user.id": ctx.from?.id });
});
```

## Traces

Run work inside a child span of the current update:

```ts
bot.command("start", async (ctx) => {
  await ctx.telemetry.trace(
    "command.start",
    { command: "start" },
    async (span) => {
      span.addEvent("command.start.handle");
      await ctx.reply("Hello! I'm a bot!");
    },
  );
});
```

`traced()` provides the same lifecycle as grammY middleware:

```ts
bot.command(
  "start",
  traced(
    "command.start",
    { command: "start" },
    async (ctx, span) => {
      span.addEvent("command.start.handle");
      await ctx.reply("Hello! I'm a bot!");
    },
  ),
);
```

## Manual spans

Custom spans can be added manually:

```ts
bot.command("finish", async (ctx) => {
  const span = ctx.telemetry.start("command.finish", { success: true });
  try {
    span.setAttribute("telegram.chat.id", ctx.chat.id);
    await ctx.reply("Finished!");
  } finally {
    span.end();
  }
});
```

> [!NOTE]
>
> `start()` returns a `DisposableSpan`. It supports `using`, which ends the span automatically when execution leaves its
> scope:
>
> ```ts
> using span = ctx.telemetry.start("command.finish", { success: true });
> ```

## Typed telemetry

You can type event and span attributes by defining maps from their names to their attributes. If you omit a map, that
signal accepts any name and attributes.

```ts
import { Bot, type Context } from "grammy";
import { openTelemetry, type OpenTelemetryContext, traced } from "@grammyjs/opentelemetry";

type BotEvents = {
  "command.start": {
    "user.id"?: number;
  };
};

type BotSpans = {
  "command.start.reply": {
    "user.id"?: number;
  };
  "command.finish": {
    success: boolean;
  };
};

type BotContext = Context & OpenTelemetryContext<BotSpans, BotEvents>;

const bot = new Bot<BotContext>("token");
const { telemetryMiddleware, telemetryTransformer } = openTelemetry<BotSpans, BotEvents>("my-bot");
bot.use(telemetryMiddleware);
bot.api.config.use(telemetryTransformer);

bot.command("start", async (ctx) => {
  ctx.telemetry.event("command.start", { "user.id": ctx.from?.id });

  await ctx.telemetry.trace(
    "command.start.reply",
    { "user.id": ctx.from?.id },
    async (span) => {
      const message = await ctx.reply("Hello!");
      span.setAttribute("telegram.message.id", message.message_id);
    },
  );

  // Type error: "command.unknown" is not defined in BotEvents.
  ctx.telemetry.event("command.unknown", {});

  // Type error: "command.start" events require a numeric "user.id".
  ctx.telemetry.event("command.start", { "user.id": "123" });

  // Type error: "command.unknown" is not defined in BotSpans.
  ctx.telemetry.start("command.unknown", {});

  // Type error: "command.finish" spans require "success".
  ctx.telemetry.start("command.finish", {});

  // Type error: "user.id" must be a number.
  await ctx.telemetry.trace(
    "command.start.reply",
    { "user.id": "123" },
    async (span) => {
      span.addEvent("reply.started");
      await ctx.reply("Hello!");
    },
  );
});

// Type error: "command.finish" requires attributes before the callback.
bot.command(
  "finish",
  traced("command.finish", async (ctx) => {
    await ctx.reply("Finished!");
  }),
);
```
