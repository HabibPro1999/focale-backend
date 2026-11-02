import pg from "pg";
import { readFile } from "node:fs/promises";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";

const databaseUrl = process.env.DATABASE_URL;
const base = process.env.NETWORKING_TEST_API_URL || "http://127.0.0.1:3080/api";
if (
  !databaseUrl ||
  !["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname) ||
  !new URL(databaseUrl).pathname.includes("networking_test_") ||
  !["localhost", "127.0.0.1"].includes(new URL(base).hostname)
)
  throw new Error("HTTP smoke requires isolated local test services");
const fixture = JSON.parse(
  await readFile("/tmp/focale-networking-qa/fixture.json", "utf8"),
);
const secret = await readFile("/tmp/focale-networking-qa/token-secret", "utf8");
const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();
async function api(path, { method = "GET", body, token } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  if (!response.ok)
    throw new Error(
      `${method} ${path}: ${response.status} ${json.error?.message ?? json.message ?? "request failed"}`,
    );
  return json.ok === true ? json.data : json;
}
async function login(email) {
  const challenge = await api(`/networking/${fixture.slug}/auth/request`, {
    method: "POST",
    body: { email },
  });
  const result = await db.query(
    "SELECT payload FROM networking_deliveries WHERE type='OTP' AND payload->>'challengeId'=$1",
    [challenge.challengeId],
  );
  assert.equal(
    result.rows.length,
    1,
    "eligible participant receives a durable OTP delivery",
  );
  const [iv, tag, ciphertext] = result.rows[0].payload.encryptedCode
    .split(".")
    .map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv(
    "aes-256-gcm",
    createHash("sha256").update(secret).digest(),
    iv,
  );
  decipher.setAuthTag(tag);
  const code = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString();
  return api(`/networking/${fixture.slug}/auth/verify`, {
    method: "POST",
    body: { challengeId: challenge.challengeId, code },
  });
}
try {
  const a = await login("amel@example.test"),
    b = await login("karim@example.test");
  assert.equal(a.profile.id, fixture.participants[0].profileId);
  assert.equal(b.profile.id, fixture.participants[1].profileId);
  console.log("PASS two independent participant OTP logins");
  const prefix = `/networking/${fixture.slug}`;
  const recommendations = await api(prefix + "/recommendations", {
    token: a.token,
  });
  assert.ok(Array.isArray(recommendations.items));
  console.log(`PASS recommendation retrieval (${recommendations.strategy})`);
  await api(prefix + "/interests", {
    method: "POST",
    token: a.token,
    body: { profileId: b.profile.id, action: "LIKE" },
  });
  const match = await api(prefix + "/interests", {
    method: "POST",
    token: b.token,
    body: { profileId: a.profile.id, action: "LIKE" },
  });
  assert.equal(match.matched, true);
  assert.ok(match.connectionId);
  console.log("PASS mutual matching");
  const messageId = randomUUID();
  const message = await api(
    prefix + `/connections/${match.connectionId}/messages`,
    {
      method: "POST",
      token: a.token,
      body: {
        body: "Bonjour Karim, discutons de notre projet médical.",
        clientMessageId: messageId,
      },
    },
  );
  const replay = await api(
    prefix + `/connections/${match.connectionId}/messages`,
    {
      method: "POST",
      token: a.token,
      body: {
        body: "Bonjour Karim, discutons de notre projet médical.",
        clientMessageId: messageId,
      },
    },
  );
  assert.equal(message.id, replay.id);
  const conversations = await api(prefix + "/connections", { token: b.token });
  assert.ok(
    conversations.items.find((item) => item.id === match.connectionId)
      .unreadCount > 0,
  );
  await api(prefix + `/connections/${match.connectionId}/read`, {
    method: "POST",
    token: b.token,
  });
  console.log("PASS persisted chat, unread state, and idempotent send");
  const avail = await api(prefix + "/availability", { token: a.token });
  const existing = await api(prefix + "/meetings", { token: a.token });
  const used = new Set(
    existing.items
      .filter((item) =>
        ["CONFIRMED", "PENDING_ALLOCATION", "PENDING"].includes(item.status),
      )
      .map((item) => item.startsAt),
  );
  const slots = avail.availableSlots
    .filter(
      (slot) => Date.parse(slot) > Date.now() + 3600000 && !used.has(slot),
    )
    .slice(0, 2);
  assert.equal(slots.length, 2, "two future slots remain available");
  for (const token of [a.token, b.token])
    await api(prefix + "/availability", {
      method: "PUT",
      token,
      body: { slots: avail.availableSlots },
    });
  const requested = await api(prefix + "/meetings", {
    method: "POST",
    token: a.token,
    body: {
      profileId: b.profile.id,
      startsAt: slots[0],
      message: "Présentation du projet",
    },
  });
  assert.equal(requested.status, "PENDING");
  const confirmed = await api(prefix + `/meetings/${requested.id}/respond`, {
    method: "POST",
    token: b.token,
    body: { action: "ACCEPT" },
  });
  assert.equal(confirmed.status, "CONFIRMED");
  assert.ok(confirmed.tableId);
  const proposal = await api(prefix + `/meetings/${requested.id}/respond`, {
    method: "POST",
    token: a.token,
    body: { action: "RESCHEDULE", startsAt: slots[1] },
  });
  assert.equal(proposal.startsAt, slots[0]);
  assert.equal(proposal.proposedStartsAt, slots[1]);
  const moved = await api(prefix + `/meetings/${requested.id}/respond`, {
    method: "POST",
    token: b.token,
    body: { action: "ACCEPT" },
  });
  assert.equal(moved.startsAt, slots[1]);
  assert.equal(moved.status, "CONFIRMED");
  console.log(
    "PASS meeting request, acceptance, whole-table allocation, and rescheduling",
  );
  const ics = await fetch(base + prefix + "/calendar.ics", {
    headers: { authorization: `Bearer ${a.token}` },
  });
  assert.ok(ics.ok);
  assert.match(await ics.text(), /BEGIN:VCALENDAR/);
  console.log("PASS participant calendar export");
  const cancelled = await api(prefix + `/meetings/${requested.id}/respond`, {
    method: "POST",
    token: a.token,
    body: { action: "CANCEL" },
  });
  assert.equal(cancelled.status, "CANCELLED");
  const held = await db.query(
    "SELECT count(*)::int AS count FROM networking_reservations WHERE meeting_id=$1",
    [requested.id],
  );
  assert.equal(held.rows[0].count, 0);
  console.log("PASS cancellation releases every reservation");
  await api(prefix + "/auth/logout", { method: "POST", token: a.token });
  const revoked = await fetch(base + prefix + "/me", {
    headers: { authorization: `Bearer ${a.token}` },
  });
  assert.equal(revoked.status, 401);
  console.log("PASS session revocation");
} finally {
  await db.end();
}
