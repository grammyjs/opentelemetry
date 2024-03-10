// deno-lint-ignore-file no-console
import { build, emptyDir } from "https://deno.land/x/dnt@0.39.0/mod.ts";

const version = Deno.args[0];
if (!version) {
  console.error("Version not provided.");
  Deno.exit(1);
}

const entryPoint = Deno.args[1];
if (!entryPoint) {
  console.error("Entry point not provided.");
  Deno.exit(1);
}

await emptyDir("./dist");

await build({
  entryPoints: [entryPoint],
  outDir: "./dist",
  typeCheck: "both",
  test: false,
  shims: {},
  compilerOptions: { lib: ["ESNext"] },
  packageManager: "npm",
  package: {
    name: "@grammyjs/open-telemetry",
    version,
    description: "grammY plugin that adds OpenTelemetry tracing to your bot",
    author: "Roz <roz@rjmunhoz.me>",
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/grammyjs/open-telemetry.git",
    },
    dependencies: {
      "@opentelemetry/api": "1.8.0",
      "@opentelemetry/exporter-trace-otlp-http": "0.49.1",
      "@opentelemetry/resources": "1.22.0",
      "@opentelemetry/sdk-trace-base": "1.22.0",
      "@opentelemetry/semantic-conventions": "1.22.0",
    },
    devDependencies: {
      "grammy": "1",
      "@opentelemetry/otlp-exporter-base": "0.49.1",
    },
  },
  postBuild(): void {
    Deno.copyFileSync("LICENSE", "dist/LICENSE");
    Deno.copyFileSync("README.md", "dist/README.md");
  },
});
