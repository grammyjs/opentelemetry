// deno-lint-ignore-file no-console
import { DiagLogLevel } from "npm:@opentelemetry/api";
import { Bot, Context } from "npm:grammy";
import { getHttpTracer, openTelemetry, OpenTelemetryContext, traced } from "./mod.ts";

type AppContext = Context & OpenTelemetryContext;

const bot = new Bot<AppContext>("298746736:AAFCUMzjfYa0TWFtRdD7GwkPWtsrNX59pZA");

const tracer = getHttpTracer("telegram-bot");
bot.use(openTelemetry(tracer, { logLevel: DiagLogLevel.ERROR }));
//bot.api.config.use(openTelemetryTransformer(tracer, { skip: (m) => m === "getUpdates" }));

bot.command("start", (ctx) => {
  return ctx.openTelemetry.trace(
    "command.start",
    { ["user.id"]: ctx.from?.id },
    async (span) => {
      span.addEvent("command.start.handle");
      await ctx.reply("Hello! I'm a bot!");
      await ctx.reply("I can help you with a lot of things!");
    },
  );
});

bot.command(
  "ping",
  traced("command.ping", async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await ctx.reply("Pong!");
  }),
);

bot.start({
  onStart: ({ username }) => {
    console.log(`Listening as @${username}`);
  },
});
