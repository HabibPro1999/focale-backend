import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  getCertificateTemplateWithEvent: vi.fn(),
  getRegistrationFormLanguage: vi.fn(async () => "fr"),
  getRegistrationFormSchema: vi.fn(async () => null),
  getTemplateByTrigger: vi.fn(),
}));
const { sendEmail, generateCertificatePdf } = vi.hoisted(() => ({
  sendEmail: vi.fn(), generateCertificatePdf: vi.fn(async () => Buffer.from("pdf")),
}));
vi.mock("@app/integrations", async (original) => ({
  ...(await original<typeof import("@app/integrations")>()),
  getEmailProvider: () => ({ sendEmail }), generateCertificatePdf,
}));
import * as db from "@app/db";
import { CertificatesService } from "./certificates.service";
const service = new CertificatesService();
describe("certificate test send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.getCertificateTemplateWithEvent).mockResolvedValue({
      id: "template", eventId: "event", name: "Attendance", templateUrl: "https://example.test/image.png",
      templateWidth: 100, templateHeight: 100, zones: [{ variable: "firstName" }],
      access: null, active: false,
    } as never);
    vi.mocked(db.getTemplateByTrigger).mockResolvedValue({ subject: "Certificate {{firstName}}", htmlContent: "<p>{{firstName}}</p>", plainContent: "{{firstName}}" } as never);
    sendEmail.mockResolvedValue({ success: true, messageId: "message" });
  });
  it("renders even a draft template and sends a PDF only to the signed-in admin", async () => {
    await expect(service.testSendCertificate("template", { email: "admin@example.test", name: "Admin" })).resolves.toMatchObject({ success: true });
    expect(generateCertificatePdf).toHaveBeenCalledOnce();
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "admin@example.test", toName: "Admin", subject: expect.stringMatching(/^\[TEST\]/),
      attachments: [expect.objectContaining({ type: "application/pdf", content: Buffer.from("pdf").toString("base64") })],
    }));
  });
  it("rejects an image-less template before rendering or sending", async () => {
    vi.mocked(db.getCertificateTemplateWithEvent).mockResolvedValue({ eventId: "event", templateUrl: "" } as never);
    await expect(service.testSendCertificate("template", { email: "admin@example.test", name: "Admin" })).rejects.toMatchObject({ statusCode: 400 });
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("reports provider rejection as an upstream error", async () => {
    sendEmail.mockResolvedValue({ success: false, error: "Rejected" });
    await expect(service.testSendCertificate("template", { email: "admin@example.test", name: "Admin" })).rejects.toMatchObject({ statusCode: 502 });
  });
});
