import { relations } from "drizzle-orm";
import { clients, users } from "./users-clients";
import { accessCheckIns, accessPrerequisites, eventAccess, events } from "./events-access";
import { forms } from "./forms";
import { eventPricing } from "./pricing";
import { certificateTemplates } from "./certificates";
import { paymentTransaction, registrations } from "./registrations";
import { sponsorshipBatches, sponsorshipUsages, sponsorships } from "./sponsorships";
import { emailLogs, emailTemplates } from "./email";
import {
  abstractCodeCounters,
  abstractCommitteeMemberships,
  abstractConfig,
  abstractReviewerThemes,
  abstractReviews,
  abstractRevisions,
  abstractThemeLinks,
  abstractThemes,
  abstracts,
} from "./abstracts";

// Drizzle relations for the query builder. Covers the common navigational graph;
// tables with no in-app joins (outbox_events, audit_logs) are intentionally omitted.

export const clientsRelations = relations(clients, ({ many }) => ({
  users: many(users),
  events: many(events),
  emailTemplates: many(emailTemplates),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  client: one(clients, { fields: [users.clientId], references: [clients.id] }),
  committeeMemberships: many(abstractCommitteeMemberships),
  reviews: many(abstractReviews),
  reviewerThemes: many(abstractReviewerThemes),
}));

export const eventsRelations = relations(events, ({ one, many }) => ({
  client: one(clients, { fields: [events.clientId], references: [clients.id] }),
  forms: many(forms),
  pricing: one(eventPricing),
  access: many(eventAccess),
  registrations: many(registrations),
  emailTemplates: many(emailTemplates),
  sponsorshipBatches: many(sponsorshipBatches),
  sponsorships: many(sponsorships),
  certificateTemplates: many(certificateTemplates),
  abstractConfig: one(abstractConfig),
  abstracts: many(abstracts),
}));

export const formsRelations = relations(forms, ({ one, many }) => ({
  event: one(events, { fields: [forms.eventId], references: [events.id] }),
  registrations: many(registrations),
  sponsorshipBatches: many(sponsorshipBatches),
}));

export const eventPricingRelations = relations(eventPricing, ({ one }) => ({
  event: one(events, { fields: [eventPricing.eventId], references: [events.id] }),
}));

export const eventAccessRelations = relations(eventAccess, ({ one, many }) => ({
  event: one(events, { fields: [eventAccess.eventId], references: [events.id] }),
  certificateTemplates: many(certificateTemplates),
  accessCheckIns: many(accessCheckIns),
  prerequisites: many(accessPrerequisites),
}));

export const accessPrerequisitesRelations = relations(accessPrerequisites, ({ one }) => ({
  access: one(eventAccess, {
    fields: [accessPrerequisites.a],
    references: [eventAccess.id],
    relationName: "access",
  }),
  requires: one(eventAccess, {
    fields: [accessPrerequisites.b],
    references: [eventAccess.id],
    relationName: "requires",
  }),
}));

export const accessCheckInsRelations = relations(accessCheckIns, ({ one }) => ({
  registration: one(registrations, {
    fields: [accessCheckIns.registrationId],
    references: [registrations.id],
  }),
  access: one(eventAccess, {
    fields: [accessCheckIns.accessId],
    references: [eventAccess.id],
  }),
}));

export const certificateTemplatesRelations = relations(
  certificateTemplates,
  ({ one }) => ({
    event: one(events, {
      fields: [certificateTemplates.eventId],
      references: [events.id],
    }),
    access: one(eventAccess, {
      fields: [certificateTemplates.accessId],
      references: [eventAccess.id],
    }),
  }),
);

export const registrationsRelations = relations(registrations, ({ one, many }) => ({
  form: one(forms, { fields: [registrations.formId], references: [forms.id] }),
  event: one(events, { fields: [registrations.eventId], references: [events.id] }),
  emailLogs: many(emailLogs),
  sponsorshipUsages: many(sponsorshipUsages),
  transactions: many(paymentTransaction),
  accessCheckIns: many(accessCheckIns),
  abstracts: many(abstracts),
}));

export const paymentTransactionRelations = relations(paymentTransaction, ({ one }) => ({
  registration: one(registrations, {
    fields: [paymentTransaction.registrationId],
    references: [registrations.id],
  }),
}));

export const sponsorshipBatchesRelations = relations(
  sponsorshipBatches,
  ({ one, many }) => ({
    event: one(events, {
      fields: [sponsorshipBatches.eventId],
      references: [events.id],
    }),
    form: one(forms, { fields: [sponsorshipBatches.formId], references: [forms.id] }),
    sponsorships: many(sponsorships),
  }),
);

export const sponsorshipsRelations = relations(sponsorships, ({ one, many }) => ({
  batch: one(sponsorshipBatches, {
    fields: [sponsorships.batchId],
    references: [sponsorshipBatches.id],
  }),
  event: one(events, { fields: [sponsorships.eventId], references: [events.id] }),
  usages: many(sponsorshipUsages),
}));

export const sponsorshipUsagesRelations = relations(sponsorshipUsages, ({ one }) => ({
  sponsorship: one(sponsorships, {
    fields: [sponsorshipUsages.sponsorshipId],
    references: [sponsorships.id],
  }),
  registration: one(registrations, {
    fields: [sponsorshipUsages.registrationId],
    references: [registrations.id],
  }),
}));

export const emailTemplatesRelations = relations(emailTemplates, ({ one, many }) => ({
  client: one(clients, {
    fields: [emailTemplates.clientId],
    references: [clients.id],
  }),
  event: one(events, { fields: [emailTemplates.eventId], references: [events.id] }),
  emailLogs: many(emailLogs),
}));

export const emailLogsRelations = relations(emailLogs, ({ one }) => ({
  template: one(emailTemplates, {
    fields: [emailLogs.templateId],
    references: [emailTemplates.id],
  }),
  registration: one(registrations, {
    fields: [emailLogs.registrationId],
    references: [registrations.id],
  }),
  abstract: one(abstracts, {
    fields: [emailLogs.abstractId],
    references: [abstracts.id],
  }),
}));

export const abstractConfigRelations = relations(abstractConfig, ({ one, many }) => ({
  event: one(events, { fields: [abstractConfig.eventId], references: [events.id] }),
  themes: many(abstractThemes),
}));

export const abstractThemesRelations = relations(abstractThemes, ({ one, many }) => ({
  config: one(abstractConfig, {
    fields: [abstractThemes.configId],
    references: [abstractConfig.id],
  }),
  themeLinks: many(abstractThemeLinks),
  reviewerThemes: many(abstractReviewerThemes),
  codeCounters: many(abstractCodeCounters),
}));

export const abstractCodeCountersRelations = relations(
  abstractCodeCounters,
  ({ one }) => ({
    event: one(events, {
      fields: [abstractCodeCounters.eventId],
      references: [events.id],
    }),
    theme: one(abstractThemes, {
      fields: [abstractCodeCounters.themeId],
      references: [abstractThemes.id],
    }),
  }),
);

export const abstractsRelations = relations(abstracts, ({ one, many }) => ({
  event: one(events, { fields: [abstracts.eventId], references: [events.id] }),
  registration: one(registrations, {
    fields: [abstracts.registrationId],
    references: [registrations.id],
  }),
  revisions: many(abstractRevisions),
  themeLinks: many(abstractThemeLinks),
  emailLogs: many(emailLogs),
  reviews: many(abstractReviews),
}));

export const abstractCommitteeMembershipsRelations = relations(
  abstractCommitteeMemberships,
  ({ one }) => ({
    user: one(users, {
      fields: [abstractCommitteeMemberships.userId],
      references: [users.id],
    }),
    event: one(events, {
      fields: [abstractCommitteeMemberships.eventId],
      references: [events.id],
    }),
  }),
);

export const abstractReviewsRelations = relations(abstractReviews, ({ one }) => ({
  abstract: one(abstracts, {
    fields: [abstractReviews.abstractId],
    references: [abstracts.id],
  }),
  event: one(events, { fields: [abstractReviews.eventId], references: [events.id] }),
  reviewer: one(users, {
    fields: [abstractReviews.reviewerId],
    references: [users.id],
  }),
}));

export const abstractReviewerThemesRelations = relations(
  abstractReviewerThemes,
  ({ one }) => ({
    user: one(users, {
      fields: [abstractReviewerThemes.userId],
      references: [users.id],
    }),
    event: one(events, {
      fields: [abstractReviewerThemes.eventId],
      references: [events.id],
    }),
    theme: one(abstractThemes, {
      fields: [abstractReviewerThemes.themeId],
      references: [abstractThemes.id],
    }),
  }),
);

export const abstractRevisionsRelations = relations(abstractRevisions, ({ one }) => ({
  abstract: one(abstracts, {
    fields: [abstractRevisions.abstractId],
    references: [abstracts.id],
  }),
}));

export const abstractThemeLinksRelations = relations(abstractThemeLinks, ({ one }) => ({
  abstract: one(abstracts, {
    fields: [abstractThemeLinks.abstractId],
    references: [abstracts.id],
  }),
  theme: one(abstractThemes, {
    fields: [abstractThemeLinks.themeId],
    references: [abstractThemes.id],
  }),
}));
