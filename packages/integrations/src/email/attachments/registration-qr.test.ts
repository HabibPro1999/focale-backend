import jsQR from "jsqr";
import QRCode from "qrcode";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { buildCheckinQrPayload, CHECKIN_QR_OPTIONS, renderRegistrationQrPng } from "./registration-qr";

const REGISTRATION_ID = "3f2b8c1e-6a4d-4e2f-9b7a-1c5d8e9f0a12";

/**
 * GOLDEN: the module matrix qrcode@1.5.4 builds for REGISTRATION_ID at ECC
 * level M (rows of modules.get(row, col)). The admin repo's checkinQr test
 * holds this exact matrix: change neither the library version nor the options
 * on one side only, or the emailed QR stops matching registration details.
 */
const GOLDEN_MATRIX = [
  "11111110000101010011101111111",
  "10000010011111110010101000001",
  "10111010111001000001101011101",
  "10111010101000111110101011101",
  "10111010110110000111001011101",
  "10000010111000011000001000001",
  "11111110101010101010101111111",
  "00000000100100110001000000000",
  "10111110010010011110001111100",
  "01111100110111100001111110011",
  "00101110000101111010100010100",
  "01110001010011010000010110011",
  "11110110001110110101110101110",
  "10101101111010001011011010101",
  "10100010111100010110101110010",
  "10100001001010110000100011011",
  "11000111110100011111010000100",
  "11000101000111100001001110011",
  "10101011000001110000000001100",
  "10010101110001001001110110001",
  "10010011100100110100111111110",
  "00000000101100001010100010001",
  "11111110011110011001101011010",
  "10000010110100110011100011010",
  "10111010111110001110111110100",
  "10111010100011100100100101011",
  "10111010101110111010011011010",
  "10000010001100011011100110010",
  "11111110110001110100000100100",
];

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
