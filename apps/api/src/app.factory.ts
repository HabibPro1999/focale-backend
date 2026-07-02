import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { newId } from "@app/shared";
import { AppModule } from "./app.module";
import { loadConfig, type Config } from "./core/config";
import { requestContext } from "./core/request-context";

/** Build the fully-wired Nest+Fastify app (plugins, requestId hook). Shared by main.ts and tests. */
export async function buildApp(
  config: Config = loadConfig(),
): Promise<NestFastifyApplication> {
  const wildcardCors = config.corsOrigins.includes("*");
  if (config.isProduction && wildcardCors) {
    throw new Error(
      "Refusing to boot: wildcard CORS origin with credentials is not allowed in production.",
    );
  }

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    { bufferLogs: true },
  );

  const fastify = app.getHttpAdapter().getInstance();

  // requestId context + response header, before Nest handlers run.
  fastify.addHook("onRequest", (req, reply, done) => {
    const incoming = req.headers["x-request-id"];
    const requestId =
      (Array.isArray(incoming) ? incoming[0] : incoming) || newId();
    void reply.header("x-request-id", requestId);
    requestContext.enterWith({ requestId });
    done();
  });

  await fastify.register(helmet);
  await fastify.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: true,
  });
  await fastify.register(cookie);

  app.enableShutdownHooks();
  return app;
}
