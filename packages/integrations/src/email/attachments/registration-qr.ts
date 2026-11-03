// =============================================================================
// REGISTRATION CHECK-IN QR
// The QR code emailed to a registrant must be the one the admin app shows in
// the registration details (and prints on badges), which the check-in scanner
// reads: the same payload, library (qrcode, pinned to the same version in both
// repos) and options. registration-qr.test.ts holds a golden module matrix
// that the admin repo's test repeats, so drift on either side fails CI. The
// badge PDF draws the same module matrix as vector rectangles.
// =============================================================================

import QRCode, { type BitMatrix, type QRCodeToBufferOptions } from "qrcode";

/** PNG rendering options, identical to the admin app's CHECKIN_QR_OPTIONS. */
export const CHECKIN_QR_OPTIONS = {
  errorCorrectionLevel: "M",
  margin: 1,
  width: 400,
  type: "png",
  color: { dark: "#000000", light: "#ffffff" },
} as const satisfies QRCodeToBufferOptions;

/** What the check-in QR encodes: the raw registration id, nothing else. */
export function buildCheckinQrPayload(registrationId: string): string {
  return registrationId;
}

/** The registration's check-in QR code as a PNG. */
export function renderRegistrationQrPng(registrationId: string): Promise<Buffer> {
  return QRCode.toBuffer(buildCheckinQrPayload(registrationId), CHECKIN_QR_OPTIONS);
}

/**
 * The check-in QR's module matrix (same payload and error correction as the
 * PNG): what the badge PDF draws, module by module. Excludes the quiet zone
 * (CHECKIN_QR_OPTIONS.margin modules on each side).
 */
export function buildCheckinQrMatrix(registrationId: string): BitMatrix {
  return QRCode.create(buildCheckinQrPayload(registrationId), {
    errorCorrectionLevel: CHECKIN_QR_OPTIONS.errorCorrectionLevel,
  }).modules;
}

/** A horizontal run of dark modules: `length` modules from (row, col). */
export interface QrModuleRun {
  row: number;
  col: number;
  length: number;
}

/** The dark modules of `matrix` as maximal horizontal runs, row by row, left to right. */
export function qrModuleRuns(
  matrix: { size: number; get(row: number, col: number): number | boolean },
): QrModuleRun[] {
  const runs: QrModuleRun[] = [];
  for (let row = 0; row < matrix.size; row++) {
    let col = 0;
    while (col < matrix.size) {
      if (!matrix.get(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < matrix.size && matrix.get(row, col)) col++;
      runs.push({ row, col: start, length: col - start });
    }
  }
  return runs;
}
