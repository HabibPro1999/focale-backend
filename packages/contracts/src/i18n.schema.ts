import { z } from "zod";

export const LanguageCodeSchema = z.enum(["fr", "en", "ar"]);

// Ordered list of the languages a form is authored in. The first entry is the
// primary language — the one the plain (untranslated) props are written in.
export const FormLanguagesSchema = z
  .array(LanguageCodeSchema)
  .min(1)
  .max(3)
  .refine((langs) => new Set(langs).size === langs.length, {
    message: "languages must not contain duplicates",
  });

// Sidecar translations map. Strict so an unknown language code is a 400 rather
// than a silently ignored blob riding along in the schema JSON forever.
export const translationsMapOf = <T extends z.ZodType>(entry: T) =>
  z.strictObject({
    fr: entry.optional(),
    en: entry.optional(),
    ar: entry.optional(),
  });

export type LanguageCode = z.infer<typeof LanguageCodeSchema>;
export type FormLanguages = z.infer<typeof FormLanguagesSchema>;
