import { describe, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect, alias } from "drizzle-orm/pg-core";
import { networkingConfigs, networkingProfiles } from "../schema/networking";
import { registrations } from "../schema/registrations";
import {
  activeProfile,
  admittedProfile,
  connectedPair,
  discoverableCounterpart,
  distinctIdentity,
  eligibleProfile,
  embeddableProfile,
  listedProfile,
  mutuallyUnblocked,
  networkingEventGate,
  notInteracted,
  peerCounterpart,
  profileCounterpart,
  sameIdentity,
} from "./networking-eligibility";

const dialect = new PgDialect({ casing: "snake_case" });
const render = (fragment: SQL) => dialect.sqlToQuery(fragment);
const p = alias(networkingProfiles, "p");
const r = alias(registrations, "r");

describe("networking eligibility SQL fragments (4.6)", () => {
  it("renders eligibility against the caller's aliases, statuses as parameters", () => {
    const query = render(eligibleProfile(p, r, ["PAID", "WAIVED"]));
    for (const clause of [
      `"p"."status"='ACTIVE'`,
      '"p"."consent" AND',
      '"p"."withdrawn_at" IS NULL',
      '"p"."erased_at" IS NULL',
      '"r"."event_id"="p"."event_id"',
      '"r"."networking_opt_in" IS DISTINCT FROM false',
      '"r"."payment_status"::text IN ($1,$2)',
    ])
      expect(query.sql).toContain(clause);
    expect(query.params).toEqual(["PAID", "WAIVED"]);
  });
  it("reads the statuses from the event's config column when asked", () => {
    const c = alias(networkingConfigs, "cfg");
    const query = render(eligibleProfile(p, r, { config: c.config }));
    expect(query.sql).toContain(`("cfg"."config"->'eligiblePaymentStatuses' ? "r"."payment_status"::text)`);
    expect(query.params).toEqual([]);
  });
  it("never matches with no eligible status", () => {
    expect(render(eligibleProfile(p, r, [])).sql).toContain("AND false)");
  });
  it("binds identifiers as parameters, never as SQL", () => {
    const hostile = "x' OR '1'='1";
    for (const fragment of [
      mutuallyUnblocked(hostile, hostile, p.id),
      notInteracted(hostile, hostile, p.id),
      connectedPair(hostile, hostile, p.id),
      distinctIdentity(p, { eventId: hostile, profileId: hostile }),
      sameIdentity(p, hostile),
    ]) {
      const query = render(fragment);
      expect(query.sql).not.toContain(hostile);
      expect(query.params).toContain(hostile);
    }
  });
  it("checks blocks both ways and the viewer's own address", () => {
    expect(render(mutuallyUnblocked("e", "viewer", p.id)).sql).toContain(
      '((elig_b.profile_id=$2 AND elig_b.target_id="p"."id") OR (elig_b.profile_id="p"."id" AND elig_b.target_id=$3))',
    );
    const identity = render(distinctIdentity(p, { eventId: "e", profileId: "viewer" }));
    expect(identity.sql).toContain('"p"."id"<>$1 AND lower(btrim("p"."email"))<>(SELECT lower(btrim(elig_v.email))');
    const own = render(distinctIdentity(p, { eventId: "e", profileId: "viewer", email: sql.raw("v.email") }));
    expect(own.sql).toContain("lower(btrim(v.email))");
  });
  it("composes the counterpart modes from the same pieces", () => {
    const discover = render(discoverableCounterpart(p, r, ["PAID"], { eventId: "e", profileId: "viewer" })).sql;
    const peer = render(peerCounterpart(p, r, ["PAID"], { eventId: "e", profileId: "viewer" })).sql;
    for (const shared of ['"p"."withdrawn_at" IS NULL', "networking_blocks elig_b", 'lower(btrim("p"."email"))'])
      for (const text of [discover, peer]) expect(text).toContain(shared);
    expect(discover).toContain(`"p"."visible" AND (btrim("p"."first_name")<>''`);
    expect(peer).not.toContain('"p"."visible"');
    expect(render(admittedProfile(p, r, ["PAID"])).sql).toContain(
      `elig_m.event_id="p"."event_id" AND elig_m.status='CONFIRMED'`,
    );
    expect(render(listedProfile(p)).sql).toBe('"p"."erased_at" IS NULL');
    expect(render(activeProfile(p)).sql).toBe(
      `("p"."status"='ACTIVE' AND "p"."consent" AND "p"."withdrawn_at" IS NULL AND "p"."erased_at" IS NULL)`,
    );
    const embeddable = render(embeddableProfile(p, r, ["PAID"])).sql;
    expect(embeddable).toContain('"p"."withdrawn_at" IS NULL');
    expect(embeddable).toContain('AND "p"."visible")');
    expect(embeddable).not.toContain("btrim");
  });
  it("profile mode: a peer, discoverable while discovery is on, or connected (4.9)", () => {
    const viewer = { eventId: "e", profileId: "viewer" };
    const open = render(profileCounterpart(p, r, ["PAID"], viewer, true)).sql;
    const peer = render(peerCounterpart(p, r, ["PAID"], viewer)).sql;
    expect(open.startsWith(`(${peer}`)).toBe(true);
    expect(open).toContain(`"p"."visible" AND (btrim("p"."first_name")<>''`);
    expect(open).toContain(
      '((elig_pc.profile_a_id=$9 AND elig_pc.profile_b_id="p"."id") OR (elig_pc.profile_a_id="p"."id" AND elig_pc.profile_b_id=$10))',
    );
    // Discovery off: only a connection shows the profile.
    const closed = render(profileCounterpart(p, r, ["PAID"], viewer, false)).sql;
    expect(closed).toContain("AND (false OR EXISTS (SELECT 1 FROM networking_connections elig_pc");
    expect(closed).not.toContain('"p"."visible"');
  });
  it("matches the participant's own profiles by trimmed, case-folded address", () => {
    const query = render(sameIdentity(p, " Ann@Example.test "));
    expect(query.sql).toBe('lower(btrim("p"."email"))=lower(btrim($1))');
    expect(query.params).toEqual([" Ann@Example.test "]);
  });
  it("gates on the config, the event and every client module", () => {
    const query = render(networkingEventGate({
      config: sql.raw("c.config"),
      eventStatus: sql.raw("ev.status"),
      clientActive: sql.raw("cl.active"),
      clientModules: sql.raw("cl.enabled_modules"),
    }));
    expect(query.sql).toContain(`c.config->>'enabled'='true' AND ev.status<>'ARCHIVED'`);
    expect(query.sql).toContain("cl.active AND cl.enabled_modules @> ARRAY[$1,$2,$3]::text[]");
    expect(query.params).toEqual(["networking", "registrations", "emails"]);
  });
});
