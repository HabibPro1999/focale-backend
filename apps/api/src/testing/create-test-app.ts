import "reflect-metadata";
import { Module, type ModuleMetadata } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE, NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { CONFIG, type Config } from "../core/config";
import { EnvelopeInterceptor } from "../core/envelope.interceptor";
import { HttpExceptionFilter } from "../core/http-exception.filter";
import { ZodValidationPipe } from "../core/zod";

/**
 * Small controller-test app with the API validation and response stack. Inject
 * requests with app.inject(), then close it in afterEach. This does not install
 * boot hooks or global throttling; use buildApp() when those are under test.
 * Production error masking preserves the former config-less test fixtures.
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
