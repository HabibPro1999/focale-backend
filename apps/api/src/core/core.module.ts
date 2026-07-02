import { Global, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE, Reflector } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { CONFIG, loadConfig, type Config } from "./config";
import { LoggerService } from "./logger.service";
import { ZodValidationPipe } from "./zod";
import { EnvelopeInterceptor } from "./envelope.interceptor";
import { HttpExceptionFilter } from "./http-exception.filter";

@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [CONFIG],
      // Legacy global limit: 100/min in prod, 1000/min otherwise, 1-minute window.
      useFactory: (config: Config) => ({
        throttlers: [{ ttl: 60_000, limit: config.security.rateLimit.max }],
      }),
    }),
  ],
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    LoggerService,
    Reflector,
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
  exports: [CONFIG, LoggerService],
})
export class CoreModule {}
