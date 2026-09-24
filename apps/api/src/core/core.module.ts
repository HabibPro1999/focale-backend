import { Global, Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE, Reflector } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import { CONFIG, type Config } from "./config";
import { LoggerService } from "./logger.service";
import { ZodValidationPipe } from "./zod";
import { EnvelopeInterceptor } from "./envelope.interceptor";
import { HttpExceptionFilter } from "./http-exception.filter";
import { NetworkingThrottlerGuard, networkingThrottlers } from "./networking-throttler.guard";
import { ShutdownCoordinator } from "./shutdown";

@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [CONFIG],
      // Legacy global limit: 100/min in prod, 1000/min otherwise, 1-minute window.
      // In-memory storage, per process: every limit assumes a single API instance.
      useFactory: (config: Config) => ({
        throttlers: [
          ...networkingThrottlers,
          { ttl: 60_000, limit: config.security.rateLimit.max },
        ],
      }),
    }),
  ],
  providers: [
    LoggerService,
    ShutdownCoordinator,
    Reflector,
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_GUARD, useClass: NetworkingThrottlerGuard },
  ],
  exports: [LoggerService, ShutdownCoordinator],
})
export class CoreModule {
  /** The config parsed once at boot (getConfig) becomes the CONFIG provider. */
  static forRoot(config: Config): DynamicModule {
    return {
      module: CoreModule,
      global: true,
      providers: [{ provide: CONFIG, useValue: config }],
      exports: [CONFIG],
    };
  }
}
