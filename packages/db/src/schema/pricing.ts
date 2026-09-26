import {
  boolean,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { StoredPricingRulesSchema } from "@app/contracts";
import { idPk, timestamps } from "../helpers";
import { jsonbOf } from "../jsonb";
import { events } from "./events-access";

export const eventPricing = pgTable(
  "event_pricing",
  {
    id: idPk(),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    basePrice: integer().notNull().default(0),
    currency: text().notNull().default("TND"),
    rules: jsonbOf(StoredPricingRulesSchema).notNull().default([]),
    onlinePaymentEnabled: boolean().notNull().default(false),
    onlinePaymentUrl: text(),
    cashPaymentEnabled: boolean().notNull().default(false),
    bankName: text(),
    bankAccountName: text(),
    bankAccountNumber: text(),
    ...timestamps,
  },
  (t) => [uniqueIndex("event_pricing_event_id_key").on(t.eventId)],
);
