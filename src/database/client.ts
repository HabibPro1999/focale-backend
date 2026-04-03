import { PrismaClient } from "@/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { config } from "@config/app.config.js";

let _pool: pg.Pool | undefined;

export function getPool(): pg.Pool | undefined {
  return _pool;
}

function createPrismaClient() {
  // Create pg Pool with proper configuration
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.database.poolSize, // 20 for prod, 5 for dev
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  _pool = pool;

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
    query: {
      user: {
        async $allOperations({ operation, args, query }) {
          // Skip omit for aggregate operations (they don't support it)
          const aggregateOps = ["count", "aggregate", "groupBy"];
          if (aggregateOps.includes(operation)) {
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
