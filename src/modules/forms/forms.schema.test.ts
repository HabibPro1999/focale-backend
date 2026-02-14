import { describe, it, expect } from "vitest";
import {
  FormSchemaJsonSchema,
  SponsorFormSchemaJsonSchema,
} from "./forms.schema.js";

describe("Forms Schema Validation", () => {
  describe("FormSchemaJsonSchema", () => {
    it("should validate a valid registration form schema", () => {
      const validSchema = {
        steps: [
          {
            id: "step-1",
            title: "Personal Information",
            description: "Please provide your details",
            fields: [
              {
                id: "firstName",
                type: "text",
                label: "First Name",
                required: true,
              },
              {
                id: "lastName",
                type: "text",
                label: "Last Name",
                required: true,
              },
              {
                id: "email",
                type: "email",
                label: "Email",
                required: true,
              },
            ],
          },
        ],
      };

      const result = FormSchemaJsonSchema.safeParse(validSchema);
      expect(result.success).toBe(true);
    });

    it("should validate schema with multiple steps", () => {
      const validSchema = {
        steps: [
          {
            id: "step-1",
            title: "Step 1",
            fields: [
              {
                id: "field-1",
                type: "text",
                label: "Field 1",
                required: false,
              },
            ],
          },
          {
            id: "step-2",
            title: "Step 2",
            fields: [
              {
                id: "field-2",
                type: "number",
                label: "Field 2",
                required: false,
              },
            ],
          },
        ],
      };

      const result = FormSchemaJsonSchema.safeParse(validSchema);
      expect(result.success).toBe(true);
    });

    it("should validate fields with all field types", () => {
      const validSchema = {
        steps: [
          {
            id: "step-1",
            title: "All Field Types",
            fields: [
              {
                id: "text-field",
                type: "text",
                label: "Text",
                required: false,
              },
              {
                id: "email-field",
                type: "email",
                label: "Email",
                required: false,
              },
              {
                id: "phone-field",
                type: "phone",
                label: "Phone",
                required: false,
              },
              {
                id: "number-field",
                type: "number",
                label: "Number",
                required: false,
              },
              {
                id: "date-field",
                type: "date",
                label: "Date",
                required: false,
              },
              {
                id: "textarea-field",
                type: "textarea",
                label: "Textarea",
                required: false,
              },
              {
                id: "dropdown-field",
                type: "dropdown",
                label: "Dropdown",
                required: false,
                options: [],
              },
              {
                id: "radio-field",
                type: "radio",
                label: "Radio",
                required: false,
                options: [],
              },
              {
                id: "checkbox-field",
                type: "checkbox",
                label: "Checkbox",
                required: false,
              },
              {
                id: "file-field",
                type: "file",
                label: "File",
                required: false,
              },
              {
                id: "heading-field",
                type: "heading",
                label: "Heading",
                required: false,
              },
              {
                id: "paragraph-field",
                type: "paragraph",
                label: "Paragraph",
                required: false,
              },
              {
                id: "governorate-field",
                type: "governorate",
                label: "Governorate",
                required: false,
              },
              {
                id: "country-field",
                type: "country",
                label: "Country",
                required: false,
              },
            ],
          },
        ],
      };

      const result = FormSchemaJsonSchema.safeParse(validSchema);
      expect(result.success).toBe(true);
    });

    it("should reject schema without steps", () => {
      const invalidSchema = {};

      const result = FormSchemaJsonSchema.safeParse(invalidSchema);
      expect(result.success).toBe(false);
    });

    it("should allow schema with empty steps array (schema permits it)", () => {
      const validSchema = {
        steps: [],
      };

      const result = FormSchemaJsonSchema.safeParse(validSchema);
      expect(result.success).toBe(true);
    });

    it("should reject step without required id", () => {
      const invalidSchema = {
        steps: [
          {
            title: "Step 1",
            fields: [],
          },
        ],
      };

      const result = FormSchemaJsonSchema.safeParse(invalidSchema);
      expect(result.success).toBe(false);
    });

    it("should reject step without required title", () => {
      const invalidSchema = {
        steps: [
          {
            id: "step-1",
            fields: [],
          },
        ],
      };

      const result = FormSchemaJsonSchema.safeParse(invalidSchema);
      expect(result.success).toBe(false);
    });

    it("should allow step with empty fields array (schema permits it)", () => {
      const validSchema = {
        steps: [
          {
            id: "step-1",
            title: "Step 1",
            fields: [],
          },
        ],
      };

      const result = FormSchemaJsonSchema.safeParse(validSchema);
      expect(result.success).toBe(true);
    });

    it("should reject field without required id", () => {
      const invalidSchema = {
        steps: [
          {
            id: "step-1",
            title: "Step 1",
            fields: [
              {
                type: "text",
                label: "Field",
                required: false,
              },
            ],
          },
        ],
      };

      const result = FormSchemaJsonSchema.safeParse(invalidSchema);
      expect(result.success).toBe(false);
    });

    it("should reject field without required type", () => {
      const invalidSchema = {
        steps: [
          {
            id: "step-1",
            title: "Step 1",
            fields: [
              {
                id: "field-1",
                label: "Field",
                required: false,
              },
            ],
          },
        ],
      };

      const result = FormSchemaJsonSchema.safeParse(invalidSchema);
      expect(result.success).toBe(false);
    });

    it("should reject field with invalid type", () => {
      const invalidSchema = {
        steps: [
          {
            id: "step-1",
            title: "Step 1",
            fields: [
              {
                id: "field-1",
                type: "invalid-type",
                label: "Field",
                required: false,
              },
            ],
          },
        ],
      };

      const result = FormSchemaJsonSchema.safeParse(invalidSchema);
      expect(result.success).toBe(false);
    });

    it("should reject schema with extra top-level properties (strict mode)", () => {
      const invalidSchema = {
        steps: [
          {
            id: "step-1",
            title: "Step 1",
            fields: [
              {
                id: "field-1",
                type: "text",
                label: "Field",
                required: false,
              },
            ],
          },
        ],
        extraProperty: "not allowed",
      };

      const result = FormSchemaJsonSchema.safeParse(invalidSchema);
      expect(result.success).toBe(false);
    });

    it("should validate field with conditions", () => {
      const validSchema = {
        steps: [
          {
            id: "step-1",
            title: "Conditional Fields",
            fields: [
              {
                id: "profession",
                type: "dropdown", // Schema uses "dropdown" not "select"
                label: "Profession",
                required: true,
                options: [
                  { id: "doctor", label: "Doctor" },
                  { id: "nurse", label: "Nurse" },
                ],
              },
              {
                id: "specialty",
                type: "text",
                label: "Specialty",
                required: false,
                conditions: [
                  {
                    fieldId: "profession",
                    operator: "equals",
                    value: "doctor",
                  },
                ],
              },
            ],
          },
        ],
      };

      const result = FormSchemaJsonSchema.safeParse(validSchema);
      expect(result.success).toBe(true);
    });
  });

  describe("SponsorFormSchemaJsonSchema", () => {
    it("should validate a valid sponsor form schema", () => {
      const validSchema = {
        formType: "SPONSOR",
        sponsorSteps: [
          {
            id: "sponsor-info",
            title: "Sponsor Information",
            fields: [
              {
                id: "labName",
                type: "text",
                label: "Laboratory Name",
                required: true,
              },
              {
                id: "contactName",
                type: "text",
                label: "Contact Name",
                required: true,
              },
            ],
          },
        ],
        beneficiaryTemplate: {
          fields: [
            {
              id: "doctorName",
              type: "text",
              label: "Doctor Name",
              required: true,
            },
            {
              id: "email",
              type: "email",
              label: "Email",
              required: true,
            },
          ],
          minCount: 1,
          maxCount: 100,
        },
      };

      const result = SponsorFormSchemaJsonSchema.safeParse(validSchema);
      expect(result.success).toBe(true);
    });

    it("should validate sponsor schema with optional settings", () => {
      const validSchema = {
        formType: "SPONSOR",
        sponsorSteps: [
          {
            id: "sponsor-info",
            title: "Sponsor Info",
            fields: [
              {
                id: "field-1",
                type: "text",
                label: "Field 1",
                required: false,
              },
            ],
          },
        ],
        beneficiaryTemplate: {
          fields: [
            {
              id: "field-2",
              type: "text",
              label: "Field 2",
              required: false,
            },
          ],
          minCount: 1,
          maxCount: 50,
        },
        summarySettings: {
          title: "Custom Summary",
          showPriceBreakdown: false,
          termsText: "Custom terms",
        },
        sponsorshipSettings: {
          sponsorshipMode: "LINKED_ACCOUNT",
          registrantSearchScope: "UNPAID_ONLY",
          autoApproveSponsorship: true,
        },
      };

      const result = SponsorFormSchemaJsonSchema.safeParse(validSchema);
      expect(result.success).toBe(true);
    });

    it("should reject sponsor schema without formType", () => {
      const invalidSchema = {
        sponsorSteps: [
          {
            id: "step-1",
            title: "Step 1",
            fields: [
              {
                id: "field-1",
                type: "text",
                label: "Field",
                required: false,
              },
            ],
          },
        ],
        beneficiaryTemplate: {
          fields: [
            {
              id: "field-2",
              type: "text",
              label: "Field 2",
              required: false,
            },
          ],
        },
      };

      const result = SponsorFormSchemaJsonSchema.safeParse(invalidSchema);
      expect(result.success).toBe(false);
    });

    it("should reject sponsor schema with wrong formType", () => {
      const invalidSchema = {
        formType: "REGISTRATION",
        sponsorSteps: [
          {
            id: "step-1",
            title: "Step 1",
            fields: [
              {
                id: "field-1",
                type: "text",
                label: "Field",
                required: false,
              },
            ],
          },
        ],
        beneficiaryTemplate: {
          fields: [
            {
              id: "field-2",
              type: "text",
              label: "Field 2",
              required: false,
            },
          ],
        },
      };

      const result = SponsorFormSchemaJsonSchema.safeParse(invalidSchema);
      expect(result.success).toBe(false);
    });

    it("should reject sponsor schema without beneficiaryTemplate", () => {
      const invalidSchema = {
        formType: "SPONSOR",
        sponsorSteps: [
          {
            id: "step-1",
            title: "Step 1",
            fields: [
              {
                id: "field-1",
                type: "text",
                label: "Field",
                required: false,
              },
            ],
          },
        ],
      };

      const result = SponsorFormSchemaJsonSchema.safeParse(invalidSchema);
      expect(result.success).toBe(false);
    });

    it("should reject beneficiary template with minCount < 1", () => {
      const invalidSchema = {
        formType: "SPONSOR",
        sponsorSteps: [
          {
            id: "step-1",
            title: "Step 1",
            fields: [
              {
                id: "field-1",
                type: "text",
                label: "Field",
                required: false,
              },
            ],
          },
        ],
        beneficiaryTemplate: {
          fields: [
            {
              id: "field-2",
              type: "text",
              label: "Field 2",
              required: false,
            },
          ],
          minCount: 0,
          maxCount: 100,
        },
      };

      const result = SponsorFormSchemaJsonSchema.safeParse(invalidSchema);
      expect(result.success).toBe(false);
    });

    it("should reject beneficiary template with maxCount > 500", () => {
      const invalidSchema = {
        formType: "SPONSOR",
        sponsorSteps: [
          {
            id: "step-1",
            title: "Step 1",
            fields: [
              {
                id: "field-1",
                type: "text",
                label: "Field",
                required: false,
              },
            ],
          },
        ],
        beneficiaryTemplate: {
          fields: [
            {
              id: "field-2",
              type: "text",
              label: "Field 2",
              required: false,
            },
          ],
          minCount: 1,
          maxCount: 501,
        },
      };

      const result = SponsorFormSchemaJsonSchema.safeParse(invalidSchema);
      expect(result.success).toBe(false);
    });

    it("should reject invalid sponsorship mode", () => {
      const invalidSchema = {
        formType: "SPONSOR",
        sponsorSteps: [
          {
            id: "step-1",
            title: "Step 1",
            fields: [
              {
                id: "field-1",
                type: "text",
                label: "Field",
                required: false,
              },
            ],
          },
        ],
        beneficiaryTemplate: {
          fields: [
            {
              id: "field-2",
              type: "text",
              label: "Field 2",
              required: false,
            },
          ],
        },
        sponsorshipSettings: {
          sponsorshipMode: "INVALID_MODE",
        },
      };

      const result = SponsorFormSchemaJsonSchema.safeParse(invalidSchema);
      expect(result.success).toBe(false);
    });
  });
});
