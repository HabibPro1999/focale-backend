import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScratchDatabase } from "@app/db/testing";
import { createScratchDatabase } from "@app/db/testing";
import { dbTestsEnabled } from "../helpers/test-env";
import { dbTestSetupTimeoutMs } from "../../vitest.shared";

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
    let scratch: ScratchDatabase;
    beforeAll(async () => {
      // Stop before 0018, seed the legacy table shape, then resume via the same
      // runner used in production. Cockroach 0017 may remain safely deferred.
      scratch = await createScratchDatabase({ label: "networking_spaces", to: "0016" });
      await scratch.client.query(seed);
      await scratch.applyMigrations({ to: "0018" });
    }, dbTestSetupTimeoutMs());
    afterAll(async () => scratch?.close());

    it("does not interpret legacy seat capacity as the number of tables", async () => {
      const spaces = (await scratch.client.query<{ id: string; capacity: number | string }>(
        "SELECT id,capacity FROM networking_spaces ORDER BY id",
      )).rows.map((row) => ({ ...row, capacity: Number(row.capacity) }));
      expect(spaces).toEqual([
        { id: "stand", capacity: 1 },
        { id: "table", capacity: 1 },
      ]);
      const tables = (await scratch.client.query<{ id: string; space_id: string; capacity: number | string }>(
        "SELECT id,space_id,capacity FROM networking_tables ORDER BY id",
      )).rows.map((row) => ({ ...row, capacity: Number(row.capacity) }));
      expect(tables).toEqual([
        { id: "stand", space_id: "stand", capacity: 2 },
        { id: "table", space_id: "table", capacity: 2 },
      ]);
    });

    it("keeps meeting identity and converts only its inventory reservation to the representative", async () => {
      expect((await scratch.client.query("SELECT id,table_id,status FROM networking_meetings")).rows).toEqual([
        { id: "meeting", table_id: "stand", status: "CONFIRMED" },
      ]);
      expect((await scratch.client.query("SELECT stand_table_id FROM networking_profiles WHERE id='rep'")).rows[0].stand_table_id).toBe("stand");
      const rows = (await scratch.client.query("SELECT resource_key FROM networking_reservations")).rows;
      expect(rows).toHaveLength(6);
      expect(rows.every((row) => row.resource_key === "stand:stand:profile:rep")).toBe(true);
    });

    it("enforces two-person tables and keeps normal event cascade cleanup", async () => {
      await expect(scratch.client.query("UPDATE networking_tables SET capacity=3 WHERE id='table'")).rejects.toThrow(/CHECK constraint/i);
      await scratch.client.query(`
        INSERT INTO events(id,client_id,name,slug,start_date,end_date,updated_at) VALUES ('empty-event','client','QA','empty',now(),now(),now());
        INSERT INTO networking_spaces(id,event_id,name,kind,capacity) VALUES ('empty-space','empty-event','Empty','TABLE',1);
        INSERT INTO networking_tables(id,event_id,space_id,name,updated_at) VALUES ('empty-table','empty-event','empty-space','Table',now());
        DELETE FROM events WHERE id='empty-event';
      `);
      expect((await scratch.client.query("SELECT id FROM networking_tables WHERE id='empty-table'")).rows).toHaveLength(0);
    });
  },
);
