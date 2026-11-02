// =============================================================================
// REGISTRATION CHECK-IN QR
// The QR code emailed to a registrant must be the one the admin app shows in
// the registration details (and prints on badges), which the check-in scanner
// reads: the same payload, library (qrcode, pinned to the same version in both
// repos) and options. registration-qr.test.ts holds a golden module matrix
// that the admin repo's test repeats, so drift on either side fails CI.
// =============================================================================

import QRCode, { type QRCodeToBufferOptions } from "qrcode";

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
