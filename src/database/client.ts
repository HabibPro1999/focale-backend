import { PrismaClient } from "@/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { config } from "@config/app.config.js";

function createPrismaClient() {
  // Create pg Pool with proper configuration
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: config.database.poolSize, // 20 for prod, 5 for dev
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  const adapter = new PrismaPg(pool);

  return new PrismaClient({
    adapter,
    log: config.isDevelopment ? ["query", "error", "warn"] : ["error", "warn"],
    transactionOptions: {
      isolationLevel: "ReadCommitted", // Changed from Serializable to reduce conflicts
      maxWait: 10000, // Increased from 5s
      timeout: 30000, // Increased from 10s
    },
  }).$extends({
    /**
     * Automatic field omission for the User model.
     *
     * Prisma 7 supports global `omit` in the client constructor, but that approach
     * changes the inferred return types of User queries — breaking call sites that
     * pass `prisma` to functions typed against the base PrismaClient (e.g. tx
     * parameters). The query extension avoids this type incompatibility while
     * achieving the same runtime behaviour: createdAt and updatedAt are stripped
     * from every User query response without affecting the static types seen by
     * the rest of the codebase.
     *
     * Why omit at all: User rows are fetched frequently and these timestamps are
     * internal metadata that should not leak to API consumers or clutter
     * downstream type inference.
     */
    query: {
      user: {
        async $allOperations({ operation, args, query }) {
          // Skip omit for aggregate operations (they don't support it)
          const aggregateOps = ["count", "aggregate", "groupBy"];
          if (aggregateOps.includes(operation)) {
            return query(args);
          }

          // select and omit are mutually exclusive in Prisma
          if ("select" in args) {
            return query(args);
          }
          if ("omit" in args) {
            args.omit = { createdAt: true, updatedAt: true, ...args.omit };
          } else {
            (args as Record<string, unknown>).omit = {
              createdAt: true,
              updatedAt: true,
            };
          }
          return query(args);
        },
      },
    },
  });
}

export type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as {
  prisma: ExtendedPrismaClient;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (!config.isProduction) globalForPrisma.prisma = prisma;
