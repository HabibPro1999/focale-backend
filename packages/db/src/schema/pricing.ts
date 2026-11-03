import {
  boolean,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { StoredPricingRulesSchema } from "@app/contracts";
import { idPk, timestamps, moneyColumn } from "../helpers";
import { jsonbOf } from "../jsonb";
import { events } from "./events-access";

export const eventPricing = pgTable(
  "event_pricing",
  {
    id: idPk(),
    eventId: text()
      .notNull()
      .references(() => events.id, { onDelete: "cascade", onUpdate: "cascade" }),
    basePrice: moneyColumn().notNull().default(0),
    /** Free event: the base price is held at 0 (rules and paid access still apply). */
    isFree: boolean().notNull().default(false),
    /** Settle a free public signup (gross 0, no code) as WAIVED; only honoured with isFree. */
    autoAccept: boolean().notNull().default(false),
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
