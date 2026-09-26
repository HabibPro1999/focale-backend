// The pre-3.7b report data shapes (packages/db queries/reports.ts), which
// the legacy builders in legacy-excel-generator.ts consume. Test-only.

export interface LegacyEventSummaryData {
  event: { name: string; slug: string } | null;
  accessTypes: Array<{ id: string; name: string; type: string }>;
  registrations: Array<{
    id: string;
    paymentStatus: string;
    paymentMethod: string | null;
    accessTypeIds: string[];
    sponsorshipAmount: number;
    totalAmount: number;
  }>;
}

export interface LegacyAccessRegistrantsReportData {
  event: { name: string; slug: string } | null;
  accessItems: Array<{ id: string; name: string; type: string }>;
  registrations: Array<{
    firstName: string | null;
    lastName: string | null;
    email: string;
    phone: string | null;
    paymentStatus: string;
    totalAmount: number;
    currency: string;
    submittedAt: Date;
    accessTypeIds: string[];
  }>;
}

export interface LegacySponsorshipReportUsage {
  amountApplied: number;
  appliedAt: Date;
  registration: { firstName: string | null; lastName: string | null; email: string } | null;
}

export interface LegacySponsorshipReportRow {
  code: string;
  status: string;
  beneficiaryName: string;
  beneficiaryEmail: string;
  beneficiaryPhone: string | null;
  beneficiaryAddress: string | null;
  coversBasePrice: boolean;
  coveredAccessIds: string[];
  totalAmount: number;
  createdAt: Date;
  batch: { labName: string; contactName: string; email: string; phone: string | null };
  usages: LegacySponsorshipReportUsage[];
}

export interface LegacySponsorshipsReportData {
  event: { name: string; slug: string } | null;
  currency: string;
  accessItems: Array<{ id: string; name: string }>;
  sponsorships: LegacySponsorshipReportRow[];
}

export interface LegacyCheckInReportData {
  event: { name: string; slug: string } | null;
  accessItems: Array<{ id: string; name: string }>;
  registrations: Array<{
    id: string;
    referenceNumber: string | null;
    firstName: string | null;
    lastName: string | null;
    email: string;
    phone: string | null;
    paymentStatus: string;
    submittedAt: Date;
    checkedInAt: Date | null;
    accessTypeIds: string[];
    accessCheckIns: Array<{ accessId: string; checkedInAt: Date }>;
  }>;
}

