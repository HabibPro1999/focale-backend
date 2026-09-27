import "reflect-metadata";
import { Module, type ModuleMetadata } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE, NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { CONFIG, type Config } from "../core/config";
import { EnvelopeInterceptor } from "../core/envelope.interceptor";
import { HttpExceptionFilter } from "../core/http-exception.filter";
import { ZodValidationPipe } from "../core/zod";

/**
 * Controller-test app with the API validation, response-contract/envelope and
 * exception-filter stack. Call app.inject(), then app.close() in teardown.
 * Production masking and response projection match config-less test fixtures.
 * Route guards still run; use buildApp() for boot hooks or global throttling.
 */
export async function createTestApp({
  config = { isProduction: true },
  ...metadata
}: Pick<ModuleMetadata, "controllers" | "providers" | "imports"> & {
  config?: Pick<Config, "isProduction">;
}): Promise<NestFastifyApplication> {
  @Module({
    ...metadata,
    providers: [
      ...(metadata.providers ?? []),
      { provide: CONFIG, useValue: config },
      { provide: APP_PIPE, useClass: ZodValidationPipe },
      { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
      { provide: APP_FILTER, useClass: HttpExceptionFilter },
    ],
  })
  class TestModule {}

  const app = await NestFactory.create<NestFastifyApplication>(
    TestModule,
    new FastifyAdapter(),
    { logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
