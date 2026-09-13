import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";
import { idPk, timestamps } from "../helpers";
import { networkingProfiles } from "./networking";
import { events } from "./events-access";

export const networkingEmbeddings = pgTable(
  "networking_embeddings",
  {
    id: idPk(),
    profileId: text()
      .notNull()
      .references(() => networkingProfiles.id, { onDelete: "cascade" }),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    kind: text().$type<"PROFILE" | "OFFER" | "NEED">().notNull(),
    model: text().notNull(),
    sourceHash: text().notNull(),
    embedding: vector({ dimensions: 1536 }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("networking_embeddings_profile_kind_model_key").on(
      table.profileId,
      table.kind,
      table.model,
    ),
    index("networking_embeddings_event_kind_model_idx").on(
      table.eventId,
      table.kind,
      table.model,
    ),
  ],
);

export const networkingEmbeddingJobs = pgTable(
  "networking_embedding_jobs",
  {
    profileId: text()
      .primaryKey()
      .references(() => networkingProfiles.id, { onDelete: "cascade" }),
    sourceHash: text(),
    model: text(),
    status: text()
      .$type<"PENDING" | "PROCESSING" | "READY" | "FAILED">()
      .notNull()
      .default("PENDING"),
    attempts: integer().notNull().default(0),
    availableAt: timestamp({ withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    lockedUntil: timestamp({ withTimezone: true, precision: 3 }),
    lockToken: text(),
    indexedProfileAt: timestamp({ withTimezone: true, precision: 3 }),
    lastError: text(),
    metrics: jsonb().$type<Record<string, number>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    index("networking_embedding_jobs_pending_idx").on(
      table.status,
      table.availableAt,
    ),
  ],
);
