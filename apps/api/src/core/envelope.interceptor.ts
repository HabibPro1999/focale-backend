import {
  Inject,
  Injectable,
  Optional,
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply } from "fastify";
import { map, type Observable } from "rxjs";
import type { ZodType } from "zod";
import { CONFIG, type Config } from "./config";
import { logger } from "./logger.service";
import { getRequestId } from "./request-context";
import { RESPONSE_CONTRACT, projectOntoContract } from "./response-contract";

export const SKIP_ENVELOPE = "skipEnvelope";
/** Opt a handler/controller out of envelope wrapping (SSE, streams, raw responses). */
export const SkipEnvelope = () => SetMetadata(SKIP_ENVELOPE, true);

/** A route returned data its response contract does not accept (non-production only). */
export class ResponseContractViolation extends Error {
  constructor(
    readonly handler: string,
    readonly issues: ReadonlyArray<{ path: string; code: string }>,
  ) {
    super(
      `Response of ${handler} does not match its contract: ${issues
        .map((issue) => `${issue.path} (${issue.code})`)
        .join(", ")}`,
    );
    this.name = "ResponseContractViolation";
  }
}

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  /** Outside production: log stripped keys and validate contracted payloads. */
  private readonly diagnostics: boolean;

  constructor(
    private readonly reflector: Reflector,
    @Optional() @Inject(CONFIG) config?: Pick<Config, "isProduction">,
  ) {
    // No injected config (bare unit fixtures): production behavior, like the exception filter.
    this.diagnostics = config ? !config.isProduction : false;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_ENVELOPE, [
      context.getHandler(),
      context.getClass(),
    ]);
    const contract = this.reflector.get<ZodType | undefined>(
      RESPONSE_CONTRACT,
      context.getHandler(),
    );

    const reply = context.switchToHttp().getResponse<FastifyReply>();

    return next.handle().pipe(
      map((data) => {
        if (reply.sent) return data;
        const payload = contract ? this.applyContract(contract, data, context) : data;
        if (skip) return payload;
        return { ok: true, data: payload, requestId: getRequestId() };
      }),
    );
  }

  private applyContract(
    contract: ZodType,
    data: unknown,
    context: ExecutionContext,
  ): unknown {
    const { value, stripped } = projectOntoContract(contract, data);
    if (!this.diagnostics) return value;

    const handler = `${context.getClass().name}.${context.getHandler().name}`;
    if (stripped.length > 0) {
      // Key paths only: values may hold personal data.
      logger.warn(
        { handler, strippedKeys: stripped },
        "Response contract stripped undeclared keys",
      );
    }
    const result = contract.safeParse(value);
    if (!result.success) {
      throw new ResponseContractViolation(
        handler,
        result.error.issues.map((issue) => ({
          path: issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)",
          code: issue.code,
        })),
      );
    }
    return value;
  }
}
