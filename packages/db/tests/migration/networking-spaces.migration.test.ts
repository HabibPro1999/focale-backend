import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { assertSafeTestDatabaseUrl, dbTestsEnabled } from "../helpers/test-env";

const directory = fileURLToPath(new URL("../../migrations/", import.meta.url));
const target = "0018_networking_spaces.sql";
const seed = `
INSERT INTO clients(id,name,updated_at) VALUES ('client','QA',now());
INSERT INTO events(id,client_id,name,slug,start_date,end_date,updated_at) VALUES ('event','client','QA','qa',now(),now()+interval '2 days',now());
INSERT INTO forms(id,event_id,name,schema,updated_at) VALUES ('form','event','QA','{}',now());
INSERT INTO registrations(id,form_id,event_id,form_data,email,total_amount,price_breakdown,updated_at) VALUES
 ('registration-rep','form','event','{}','rep@example.invalid',0,'{}',now()),
 ('registration-visitor','form','event','{}','visitor@example.invalid',0,'{}',now());
INSERT INTO networking_profiles(id,event_id,registration_id,email,first_name,updated_at) VALUES
 ('rep','event','registration-rep','rep@example.invalid','Representative',now()),
 ('visitor','event','registration-visitor','visitor@example.invalid','Visitor',now());
INSERT INTO networking_tables(id,event_id,name,kind,capacity,owner_profile_id,updated_at) VALUES
 ('stand','event','Organization','STAND',10,'rep',now()),('table','event','Table','TABLE',8,NULL,now());
INSERT INTO networking_meetings(id,event_id,requester_id,recipient_id,table_id,status,starts_at,ends_at,expires_at,updated_at) VALUES
 ('meeting','event','visitor','rep','stand','CONFIRMED','2031-04-05T10:00Z','2031-04-05T10:30Z','2031-04-05T10:00Z',now());
INSERT INTO networking_reservations(id,event_id,meeting_id,resource_key,starts_at)
 SELECT 'reservation-'||n,'event','meeting','table:stand',timestamptz '2031-04-05T10:00Z'+n*interval '5 minutes' FROM generate_series(0,5) n;
`;

describe.runIf(dbTestsEnabled())(
  "spaces migration preserves existing tables, representatives and bookings",
  () => {
    let client: Client | undefined;
    let admin: Client | undefined;
    const name = `networking_test_spaces_mig_${Date.now()}`;
    beforeAll(async () => {
      const base = new URL(process.env.TEST_DATABASE_URL!);
      assertSafeTestDatabaseUrl(base.toString());
      if (!["localhost", "127.0.0.1"].includes(base.hostname))
        throw new Error("Local migration database required");
      base.pathname = "/postgres";
      admin = new Client({ connectionString: base.toString() });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${name}"`);
      base.pathname = `/${name}`;
      assertSafeTestDatabaseUrl(base.toString());
      client = new Client({ connectionString: base.toString() });
      await client.connect();
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      for (const file of readdirSync(directory)
        .filter((file) => /^\d{4}_.*\.sql$/.test(file) && file <= target)
        .sort()) {
        if (file === target) await client.query(seed);
        await client.query(readFileSync(directory + file, "utf8"));
      }
    });
    afterAll(async () => {
      await client?.end();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
        await admin.end();
      }
    });
    it("does not interpret legacy seat capacity as the number of tables", async () => {
      expect(
        (
          await client!.query(
            "SELECT id,capacity FROM networking_spaces ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { id: "stand", capacity: 1 },
        { id: "table", capacity: 1 },
      ]);
      expect(
        (
          await client!.query(
            "SELECT id,space_id,capacity FROM networking_tables ORDER BY id",
          )
        ).rows,
      ).toEqual([
        { id: "stand", space_id: "stand", capacity: 2 },
        { id: "table", space_id: "table", capacity: 2 },
      ]);
    });
    it("keeps meeting identity and converts only its inventory reservation to the representative", async () => {
      expect(
        (
          await client!.query(
            "SELECT id,table_id,status FROM networking_meetings",
          )
        ).rows,
      ).toEqual([{ id: "meeting", table_id: "stand", status: "CONFIRMED" }]);
      expect(
        (
          await client!.query(
            "SELECT stand_table_id FROM networking_profiles WHERE id='rep'",
          )
        ).rows[0].stand_table_id,
      ).toBe("stand");
      const rows = (
        await client!.query("SELECT resource_key FROM networking_reservations")
      ).rows;
      expect(rows).toHaveLength(6);
      expect(
        rows.every((row) => row.resource_key === "stand:stand:profile:rep"),
      ).toBe(true);
    });
    it("enforces two-person tables and does not prevent normal event cascade cleanup", async () => {
      await expect(
        client!.query(
          "UPDATE networking_tables SET capacity=3 WHERE id='table'",
        ),
      ).rejects.toThrow(/two_people/);
      await client!.query(`
      INSERT INTO events(id,client_id,name,slug,start_date,end_date,updated_at) VALUES ('empty-event','client','QA','empty',now(),now(),now());
      INSERT INTO networking_spaces(id,event_id,name,kind,capacity) VALUES ('empty-space','empty-event','Empty','TABLE',1);
      INSERT INTO networking_tables(id,event_id,space_id,name,updated_at) VALUES ('empty-table','empty-event','empty-space','Table',now());
      DELETE FROM events WHERE id='empty-event';
    `);
      expect(
        (
          await client!.query(
            "SELECT id FROM networking_tables WHERE id='empty-table'",
          )
        ).rows,
      ).toHaveLength(0);
    });
  },
);
