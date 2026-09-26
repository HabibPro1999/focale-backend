/** The snapshot the worker's Abstract Book job renders the PDF from. */
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../../client";
import { abstractConfig, abstracts } from "../../schema/abstracts";
import { events } from "../../schema/events-access";
import {
  loadThemesWithSort,
  type AbstractConfigRow,
  type AbstractRow,
  type ThemeWithSort,
} from "./shared";

// ----------------------------------------------------------------------------
// Abstract Book PDF data (worker book job renders the PDF from this snapshot).
// Mirrors the legacy generateAbstractBookPdf fetch: event name + book config +
// every ACCEPTED abstract with its themes. null → event missing; config null →
// caller throws "Abstract configuration not found" (legacy 404 semantics).
// ----------------------------------------------------------------------------

export interface AbstractBookConfig {
  bookFontFamily: string;
  bookFontSize: number;
  bookLineSpacing: number;
  bookOrder: AbstractConfigRow["bookOrder"];
  bookIncludeAuthorNames: boolean;
  // H9: additive — lets the book renderer print each additional-field's
  // (e.g. keywords) value alongside content sections, per its schema label.
  additionalFieldsSchema: AbstractConfigRow["additionalFieldsSchema"];
}

export interface AbstractBookData {
  eventName: string;
  config: AbstractBookConfig;
  abstracts: (AbstractRow & { themes: ThemeWithSort[] })[];
}

export async function getAbstractBookData(
  eventId: string,
): Promise<AbstractBookData | null> {
  const db = getDb();
  const [ev] = await db
    .select({ name: events.name })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!ev) return null;

  const [cfg] = await db
    .select({
      bookFontFamily: abstractConfig.bookFontFamily,
      bookFontSize: abstractConfig.bookFontSize,
      bookLineSpacing: abstractConfig.bookLineSpacing,
      bookOrder: abstractConfig.bookOrder,
      bookIncludeAuthorNames: abstractConfig.bookIncludeAuthorNames,
      additionalFieldsSchema: abstractConfig.additionalFieldsSchema,
    })
    .from(abstractConfig)
    .where(eq(abstractConfig.eventId, eventId))
    .limit(1);
  if (!cfg) return null;

  const rows = await db
    .select()
    .from(abstracts)
    .where(and(eq(abstracts.eventId, eventId), eq(abstracts.status, "ACCEPTED")))
    .orderBy(asc(abstracts.codeNumber));

  const themeMap = await loadThemesWithSort(rows.map((r) => r.id));
  return {
    eventName: ev.name,
    config: cfg,
    abstracts: rows.map((r) => ({ ...r, themes: themeMap.get(r.id) ?? [] })),
  };
}
