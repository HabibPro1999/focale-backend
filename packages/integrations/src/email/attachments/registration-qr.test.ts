import jsQR from "jsqr";
import QRCode from "qrcode";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  buildCheckinQrMatrix,
  buildCheckinQrPayload,
  CHECKIN_QR_OPTIONS,
  qrModuleRuns,
  renderRegistrationQrPng,
} from "./registration-qr";
import { GOLDEN_MATRIX, GOLDEN_REGISTRATION_ID as REGISTRATION_ID } from "./checkin-qr.golden";


function moduleRows(registrationId: string): string[] {
  const { modules } = QRCode.create(buildCheckinQrPayload(registrationId), {
    errorCorrectionLevel: CHECKIN_QR_OPTIONS.errorCorrectionLevel,
  });
  return Array.from({ length: modules.size }, (_, row) =>
    Array.from({ length: modules.size }, (_, col) => (modules.get(row, col) ? "1" : "0")).join(""),
  );
}

describe("registration check-in QR", () => {
  it("encodes the raw registration id", () => {
    expect(buildCheckinQrPayload(REGISTRATION_ID)).toBe(REGISTRATION_ID);
  });

  it("keeps the shared options", () => {
    expect(CHECKIN_QR_OPTIONS).toEqual({
      errorCorrectionLevel: "M",
      margin: 1,
      width: 400,
      type: "png",
      color: { dark: "#000000", light: "#ffffff" },
    });
  });

  it("builds exactly the golden module matrix (version 3, mask 2)", () => {
    const qr = QRCode.create(buildCheckinQrPayload(REGISTRATION_ID), { errorCorrectionLevel: "M" });
    expect([qr.modules.size, qr.version, qr.maskPattern]).toEqual([29, 3, 2]);
    expect(moduleRows(REGISTRATION_ID)).toEqual(GOLDEN_MATRIX);
  });

  it("builds the golden matrix through buildCheckinQrMatrix (what the badge PDF draws)", () => {
    const matrix = buildCheckinQrMatrix(REGISTRATION_ID);
    expect(matrix.size).toBe(29);
    expect(
      Array.from({ length: matrix.size }, (_, row) =>
        Array.from({ length: matrix.size }, (_, col) => (matrix.get(row, col) ? "1" : "0")).join(""),
      ),
    ).toEqual(GOLDEN_MATRIX);
  });

  it("qrModuleRuns: maximal row runs that rebuild the golden matrix exactly", () => {
    const runs = qrModuleRuns(buildCheckinQrMatrix(REGISTRATION_ID));
    const rows = GOLDEN_MATRIX.map((line) => Array.from(line, () => "0"));
    for (const { row, col, length } of runs) {
      expect(length).toBeGreaterThan(0);
      for (let c = col; c < col + length; c++) {
        expect(rows[row]![c]).toBe("0"); // no overlap
        rows[row]![c] = "1";
      }
    }
    expect(rows.map((r) => r.join(""))).toEqual(GOLDEN_MATRIX);
    // Maximal: a run is never followed by a dark module, nor touches the next run.
    for (const { row, col, length } of runs) expect(GOLDEN_MATRIX[row]![col + length] ?? "0").toBe("0");
    // One run per maximal block of 1s.
    expect(runs).toHaveLength(GOLDEN_MATRIX.join("|").match(/1+/g)!.length);
    expect(runs[0]).toEqual({ row: 0, col: 0, length: 7 });
  });

  it("qrModuleRuns: an empty matrix has no runs, a full row is one run", () => {
    expect(qrModuleRuns({ size: 3, get: () => 0 })).toEqual([]);
    expect(qrModuleRuns({ size: 2, get: (row) => row === 1 })).toEqual([{ row: 1, col: 0, length: 2 }]);
  });

  it("renders a 400 px PNG that decodes back to the registration id", async () => {
    const png = await renderRegistrationQrPng(REGISTRATION_ID);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const metadata = await sharp(png).metadata();
    expect(metadata).toMatchObject({ format: "png", width: 400, height: 400 });

    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const decoded = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height);
    expect(decoded?.data).toBe(REGISTRATION_ID);
  });
});
