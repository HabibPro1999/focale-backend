import { describe, it, expect, vi } from 'vitest';
import { prismaMock } from '../../../tests/mocks/prisma.js';
import {
  createMockEvent,
} from '../../../tests/helpers/factories.js';
import { faker } from '@faker-js/faker';
import {
  createEmailTemplate,
  getEmailTemplateById,
  getEmailTemplateWithEvent,
  getEmailTemplateClientId,
  listEmailTemplates,
  getTemplateByTrigger,
  updateEmailTemplate,
  deleteEmailTemplate,
  duplicateEmailTemplate,
} from './email-template.service.js';
import { AppError } from '@shared/errors/app-error.js';
import { ErrorCodes } from '@shared/errors/error-codes.js';
import type { TiptapDocument } from './email.types.js';
import type { EmailTemplate } from '@/generated/prisma/client.js';

// Mock the email renderer service
vi.mock('./email-renderer.service.js', () => ({
  renderTemplateToMjml: vi.fn().mockReturnValue('<mjml><mj-body></mj-body></mjml>'),
  compileMjmlToHtml: vi.fn().mockReturnValue({ html: '<html><body>Test</body></html>', errors: [] }),
  extractPlainText: vi.fn().mockReturnValue('Plain text content'),
}));

// ============================================================================
// Test Data Factories
// ============================================================================

function createMockTiptapDocument(overrides: Partial<TiptapDocument> = {}): TiptapDocument {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'mention', attrs: { id: 'firstName', label: 'First Name' } },
        ],
      },
    ],
    ...overrides,
  };
}

function createMockEmailTemplate(overrides: Partial<EmailTemplate> = {}): EmailTemplate {
  return {
    id: faker.string.uuid(),
    clientId: faker.string.uuid(),
    eventId: faker.string.uuid(),
    name: faker.lorem.words(3),
    description: faker.lorem.sentence(),
    subject: faker.lorem.sentence(),
    content: createMockTiptapDocument() as unknown as EmailTemplate['content'],
    mjmlContent: '<mjml><mj-body></mj-body></mjml>',
    htmlContent: '<html><body>Test</body></html>',
    plainContent: 'Plain text content',
    category: 'MANUAL',
    trigger: null,
    isDefault: false,
    isActive: true,
    abstractTrigger: null,
    createdAt: faker.date.past(),
    updatedAt: faker.date.recent(),
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Email Template Service', () => {
  const eventId = 'event-123';
  const clientId = 'client-456';
  const templateId = 'template-789';

  describe('createEmailTemplate', () => {
    it('should create a manual email template', async () => {
      const mockEvent = createMockEvent({ id: eventId, clientId });
      const mockTemplate = createMockEmailTemplate({
        eventId,
        clientId,
        category: 'MANUAL',
        name: 'Welcome Email',
        subject: 'Welcome to {{eventName}}',
      });

      prismaMock.event.findUnique.mockResolvedValue(mockEvent);
      prismaMock.emailTemplate.create.mockResolvedValue(mockTemplate);

      const result = await createEmailTemplate({
        eventId,
        name: 'Welcome Email',
        subject: 'Welcome to {{eventName}}',
        content: createMockTiptapDocument(),
        category: 'MANUAL',
      });

      expect(result.name).toBe('Welcome Email');
      expect(result.category).toBe('MANUAL');
      expect(prismaMock.emailTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId,
          eventId,
          name: 'Welcome Email',
          category: 'MANUAL',
        }),
      });
    });

    it('should create an automatic email template with trigger', async () => {
      const mockEvent = createMockEvent({ id: eventId, clientId });
      const mockTemplate = createMockEmailTemplate({
        eventId,
        clientId,
        category: 'AUTOMATIC',
        trigger: 'REGISTRATION_CREATED',
      });

      prismaMock.event.findUnique.mockResolvedValue(mockEvent);
      prismaMock.emailTemplate.findFirst.mockResolvedValue(null); // No existing template
      prismaMock.emailTemplate.create.mockResolvedValue(mockTemplate);

      const result = await createEmailTemplate({
        eventId,
        name: 'Registration Confirmation',
        subject: 'Registration Confirmed',
        content: createMockTiptapDocument(),
        category: 'AUTOMATIC',
        trigger: 'REGISTRATION_CREATED',
      });

      expect(result.category).toBe('AUTOMATIC');
      expect(result.trigger).toBe('REGISTRATION_CREATED');
    });

    it('should throw error when event not found', async () => {
      prismaMock.event.findUnique.mockResolvedValue(null);

      await expect(
        createEmailTemplate({
          eventId: 'non-existent',
          name: 'Test',
          subject: 'Test',
          content: createMockTiptapDocument(),
          category: 'MANUAL',
        })
      ).rejects.toThrow(AppError);

      await expect(
        createEmailTemplate({
          eventId: 'non-existent',
          name: 'Test',
          subject: 'Test',
          content: createMockTiptapDocument(),
          category: 'MANUAL',
        })
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    it('should throw conflict error when automatic template trigger already exists', async () => {
      const mockEvent = createMockEvent({ id: eventId, clientId });
      const existingTemplate = createMockEmailTemplate({
        eventId,
        category: 'AUTOMATIC',
        trigger: 'REGISTRATION_CREATED',
        isActive: true,
      });

      prismaMock.event.findUnique.mockResolvedValue(mockEvent);
      prismaMock.emailTemplate.findFirst.mockResolvedValue(existingTemplate);

      await expect(
        createEmailTemplate({
          eventId,
          name: 'Another Registration Email',
          subject: 'Test',
          content: createMockTiptapDocument(),
          category: 'AUTOMATIC',
          trigger: 'REGISTRATION_CREATED',
        })
      ).rejects.toThrow(AppError);

      await expect(
        createEmailTemplate({
          eventId,
          name: 'Another Registration Email',
          subject: 'Test',
          content: createMockTiptapDocument(),
          category: 'AUTOMATIC',
          trigger: 'REGISTRATION_CREATED',
        })
      ).rejects.toMatchObject({
        statusCode: 409,
        code: ErrorCodes.CONFLICT,
      });
    });

    it('should allow creating automatic template when trigger is for different event', async () => {
      const mockEvent = createMockEvent({ id: eventId, clientId });
      const mockTemplate = createMockEmailTemplate({
        eventId,
        clientId,
        category: 'AUTOMATIC',
        trigger: 'PAYMENT_CONFIRMED',
      });

      prismaMock.event.findUnique.mockResolvedValue(mockEvent);
      prismaMock.emailTemplate.findFirst.mockResolvedValue(null);
      prismaMock.emailTemplate.create.mockResolvedValue(mockTemplate);

      const result = await createEmailTemplate({
        eventId,
        name: 'Payment Confirmation',
        subject: 'Payment Received',
        content: createMockTiptapDocument(),
        category: 'AUTOMATIC',
        trigger: 'PAYMENT_CONFIRMED',
      });

      expect(result.trigger).toBe('PAYMENT_CONFIRMED');
    });

    it('should set isActive based on input', async () => {
      const mockEvent = createMockEvent({ id: eventId, clientId });
      const mockTemplate = createMockEmailTemplate({
        eventId,
        clientId,
        isActive: false,
      });

      prismaMock.event.findUnique.mockResolvedValue(mockEvent);
      prismaMock.emailTemplate.create.mockResolvedValue(mockTemplate);

      await createEmailTemplate({
        eventId,
        name: 'Draft Email',
        subject: 'Test',
        content: createMockTiptapDocument(),
        category: 'MANUAL',
        isActive: false,
      });

      expect(prismaMock.emailTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          isActive: false,
        }),
      });
    });
  });

  describe('getEmailTemplateById', () => {
    it('should return template when found', async () => {
      const mockTemplate = createMockEmailTemplate({ id: templateId });
      prismaMock.emailTemplate.findUnique.mockResolvedValue(mockTemplate);

      const result = await getEmailTemplateById(templateId);

      expect(result).not.toBeNull();
      expect(result?.id).toBe(templateId);
      expect(prismaMock.emailTemplate.findUnique).toHaveBeenCalledWith({
        where: { id: templateId },
      });
    });

    it('should return null when template not found', async () => {
      prismaMock.emailTemplate.findUnique.mockResolvedValue(null);

      const result = await getEmailTemplateById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getEmailTemplateWithEvent', () => {
    it('should return template with event relation', async () => {
      const mockEvent = createMockEvent({ id: eventId });
      const mockTemplate = createMockEmailTemplate({
        id: templateId,
        eventId,
      }) as EmailTemplate & { event: typeof mockEvent };
      (mockTemplate as unknown as { event: typeof mockEvent }).event = mockEvent;

      prismaMock.emailTemplate.findFirst.mockResolvedValue(mockTemplate);

      const result = await getEmailTemplateWithEvent(templateId);

      expect(result).not.toBeNull();
      expect(result?.event).toBeDefined();
      expect(prismaMock.emailTemplate.findFirst).toHaveBeenCalledWith({
        where: { id: templateId },
        include: { event: true },
      });
    });

    it('should return null when template not found', async () => {
      prismaMock.emailTemplate.findFirst.mockResolvedValue(null);

      const result = await getEmailTemplateWithEvent('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getEmailTemplateClientId', () => {
    it('should return clientId when template exists', async () => {
      prismaMock.emailTemplate.findUnique.mockResolvedValue({
        clientId,
      } as EmailTemplate);

      const result = await getEmailTemplateClientId(templateId);

      expect(result).toBe(clientId);
    });

    it('should return null when template not found', async () => {
      prismaMock.emailTemplate.findUnique.mockResolvedValue(null);

      const result = await getEmailTemplateClientId('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('listEmailTemplates', () => {
    it('should return paginated templates', async () => {
      const mockTemplates = [
        createMockEmailTemplate({ eventId }),
        createMockEmailTemplate({ eventId }),
      ];

      prismaMock.emailTemplate.findMany.mockResolvedValue(mockTemplates);
      prismaMock.emailTemplate.count.mockResolvedValue(2);

      const result = await listEmailTemplates(eventId, { page: 1, limit: 10 });

      expect(result.data).toHaveLength(2);
      expect(result.meta.total).toBe(2);
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(10);
    });

    it('should filter by category', async () => {
      const mockTemplates = [createMockEmailTemplate({ eventId, category: 'AUTOMATIC' })];

      prismaMock.emailTemplate.findMany.mockResolvedValue(mockTemplates);
      prismaMock.emailTemplate.count.mockResolvedValue(1);

      await listEmailTemplates(eventId, { category: 'AUTOMATIC' });

      expect(prismaMock.emailTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            eventId,
            category: 'AUTOMATIC',
          }),
        })
      );
    });

    it('should filter by search term in name or subject', async () => {
      prismaMock.emailTemplate.findMany.mockResolvedValue([]);
      prismaMock.emailTemplate.count.mockResolvedValue(0);

      await listEmailTemplates(eventId, { search: 'welcome' });

      expect(prismaMock.emailTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { name: { contains: 'welcome', mode: 'insensitive' } },
              { subject: { contains: 'welcome', mode: 'insensitive' } },
            ],
          }),
        })
      );
    });

    it('should use default pagination values', async () => {
      prismaMock.emailTemplate.findMany.mockResolvedValue([]);
      prismaMock.emailTemplate.count.mockResolvedValue(0);

      const result = await listEmailTemplates(eventId, {});

      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(20);
    });

    it('should order by createdAt descending', async () => {
      prismaMock.emailTemplate.findMany.mockResolvedValue([]);
      prismaMock.emailTemplate.count.mockResolvedValue(0);

      await listEmailTemplates(eventId, {});

      expect(prismaMock.emailTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'desc' },
        })
      );
    });
  });

  describe('getTemplateByTrigger', () => {
    it('should return active template for trigger', async () => {
      const mockTemplate = createMockEmailTemplate({
        eventId,
        category: 'AUTOMATIC',
        trigger: 'REGISTRATION_CREATED',
        isActive: true,
      });

      prismaMock.emailTemplate.findFirst.mockResolvedValue(mockTemplate);

      const result = await getTemplateByTrigger(eventId, 'REGISTRATION_CREATED');

      expect(result).not.toBeNull();
      expect(result?.trigger).toBe('REGISTRATION_CREATED');
      expect(prismaMock.emailTemplate.findFirst).toHaveBeenCalledWith({
        where: {
          eventId,
          trigger: 'REGISTRATION_CREATED',
          category: 'AUTOMATIC',
          isActive: true,
        },
      });
    });

    it('should return null when no active template for trigger', async () => {
      prismaMock.emailTemplate.findFirst.mockResolvedValue(null);

      const result = await getTemplateByTrigger(eventId, 'PAYMENT_PROOF_SUBMITTED');

      expect(result).toBeNull();
    });

    it('should not return inactive templates', async () => {
      prismaMock.emailTemplate.findFirst.mockResolvedValue(null);

      await getTemplateByTrigger(eventId, 'REGISTRATION_CREATED');

      expect(prismaMock.emailTemplate.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({
          isActive: true,
        }),
      });
    });
  });

  describe('updateEmailTemplate', () => {
    it('should update template name', async () => {
      const existingTemplate = createMockEmailTemplate({ id: templateId });
      const updatedTemplate = createMockEmailTemplate({
        id: templateId,
        name: 'Updated Name',
      });

      prismaMock.emailTemplate.findUnique.mockResolvedValue(existingTemplate);
      prismaMock.emailTemplate.update.mockResolvedValue(updatedTemplate);

      const result = await updateEmailTemplate(templateId, { name: 'Updated Name' });

      expect(result.name).toBe('Updated Name');
    });

    it('should update template subject', async () => {
      const existingTemplate = createMockEmailTemplate({ id: templateId });
      const updatedTemplate = createMockEmailTemplate({
        id: templateId,
        subject: 'New Subject',
      });

      prismaMock.emailTemplate.findUnique.mockResolvedValue(existingTemplate);
      prismaMock.emailTemplate.update.mockResolvedValue(updatedTemplate);

      const result = await updateEmailTemplate(templateId, { subject: 'New Subject' });

      expect(result.subject).toBe('New Subject');
    });

    it('should re-compile when content is updated', async () => {
      const existingTemplate = createMockEmailTemplate({ id: templateId });
      const newContent = createMockTiptapDocument();
      const updatedTemplate = createMockEmailTemplate({
        id: templateId,
        content: newContent as unknown as EmailTemplate['content'],
      });

      prismaMock.emailTemplate.findUnique.mockResolvedValue(existingTemplate);
      prismaMock.emailTemplate.update.mockResolvedValue(updatedTemplate);

      await updateEmailTemplate(templateId, { content: newContent });

      expect(prismaMock.emailTemplate.update).toHaveBeenCalledWith({
        where: { id: templateId },
        data: expect.objectContaining({
          content: expect.anything(),
          mjmlContent: expect.any(String),
          htmlContent: expect.any(String),
          plainContent: expect.any(String),
        }),
      });
    });

    it('should update isActive status', async () => {
      const existingTemplate = createMockEmailTemplate({ id: templateId, isActive: true });
      const updatedTemplate = createMockEmailTemplate({ id: templateId, isActive: false });

      prismaMock.emailTemplate.findUnique.mockResolvedValue(existingTemplate);
      prismaMock.emailTemplate.update.mockResolvedValue(updatedTemplate);

      const result = await updateEmailTemplate(templateId, { isActive: false });

      expect(result.isActive).toBe(false);
    });

    it('should throw error when template not found', async () => {
      prismaMock.emailTemplate.findUnique.mockResolvedValue(null);

      await expect(updateEmailTemplate('non-existent', { name: 'Test' })).rejects.toThrow(
        AppError
      );

      await expect(
        updateEmailTemplate('non-existent', { name: 'Test' })
      ).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    it('should allow updating description to null', async () => {
      const existingTemplate = createMockEmailTemplate({
        id: templateId,
        description: 'Old description',
      });
      const updatedTemplate = createMockEmailTemplate({
        id: templateId,
        description: null,
      });

      prismaMock.emailTemplate.findUnique.mockResolvedValue(existingTemplate);
      prismaMock.emailTemplate.update.mockResolvedValue(updatedTemplate);

      await updateEmailTemplate(templateId, { description: null });

      expect(prismaMock.emailTemplate.update).toHaveBeenCalledWith({
        where: { id: templateId },
        data: expect.objectContaining({
          description: null,
        }),
      });
    });
  });

  describe('deleteEmailTemplate', () => {
    it('should delete existing template', async () => {
      const existingTemplate = createMockEmailTemplate({ id: templateId });

      prismaMock.emailTemplate.findUnique.mockResolvedValue(existingTemplate);
      prismaMock.emailTemplate.delete.mockResolvedValue(existingTemplate);

      await deleteEmailTemplate(templateId);

      expect(prismaMock.emailTemplate.delete).toHaveBeenCalledWith({
        where: { id: templateId },
      });
    });

    it('should throw error when template not found', async () => {
      prismaMock.emailTemplate.findUnique.mockResolvedValue(null);

      await expect(deleteEmailTemplate('non-existent')).rejects.toThrow(AppError);

      await expect(deleteEmailTemplate('non-existent')).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });
  });

  describe('duplicateEmailTemplate', () => {
    it('should duplicate template with default name', async () => {
      const originalTemplate = createMockEmailTemplate({
        id: templateId,
        name: 'Original Template',
        category: 'AUTOMATIC',
        trigger: 'REGISTRATION_CREATED',
        isActive: true,
      });
      const duplicatedTemplate = createMockEmailTemplate({
        name: 'Original Template (Copy)',
        category: 'MANUAL',
        trigger: null,
        isActive: false,
      });

      prismaMock.emailTemplate.findUnique.mockResolvedValue(originalTemplate);
      prismaMock.emailTemplate.create.mockResolvedValue(duplicatedTemplate);

      const result = await duplicateEmailTemplate(templateId);

      expect(result.name).toBe('Original Template (Copy)');
      expect(result.category).toBe('MANUAL');
      expect(result.trigger).toBeNull();
      expect(result.isActive).toBe(false);
    });

    it('should duplicate template with custom name', async () => {
      const originalTemplate = createMockEmailTemplate({ id: templateId });
      const duplicatedTemplate = createMockEmailTemplate({
        name: 'Custom Name',
        category: 'MANUAL',
      });

      prismaMock.emailTemplate.findUnique.mockResolvedValue(originalTemplate);
      prismaMock.emailTemplate.create.mockResolvedValue(duplicatedTemplate);

      const result = await duplicateEmailTemplate(templateId, 'Custom Name');

      expect(result.name).toBe('Custom Name');
    });

    it('should throw error when source template not found', async () => {
      prismaMock.emailTemplate.findUnique.mockResolvedValue(null);

      await expect(duplicateEmailTemplate('non-existent')).rejects.toThrow(AppError);

      await expect(duplicateEmailTemplate('non-existent')).rejects.toMatchObject({
        statusCode: 404,
        code: ErrorCodes.NOT_FOUND,
      });
    });

    it('should copy content, mjml, html, and plain text from original', async () => {
      const originalTemplate = createMockEmailTemplate({
        id: templateId,
        clientId,
        eventId,
        content: createMockTiptapDocument() as unknown as EmailTemplate['content'],
        mjmlContent: '<mjml>original</mjml>',
        htmlContent: '<html>original</html>',
        plainContent: 'original plain',
      });

      prismaMock.emailTemplate.findUnique.mockResolvedValue(originalTemplate);
      prismaMock.emailTemplate.create.mockResolvedValue(
        createMockEmailTemplate({ name: 'Copy' })
      );

      await duplicateEmailTemplate(templateId);

      expect(prismaMock.emailTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId,
          eventId,
          mjmlContent: '<mjml>original</mjml>',
          htmlContent: '<html>original</html>',
          plainContent: 'original plain',
        }),
      });
    });

    it('should always set duplicates to MANUAL category', async () => {
      const originalTemplate = createMockEmailTemplate({
        id: templateId,
        category: 'AUTOMATIC',
        trigger: 'PAYMENT_CONFIRMED',
      });

      prismaMock.emailTemplate.findUnique.mockResolvedValue(originalTemplate);
      prismaMock.emailTemplate.create.mockResolvedValue(
        createMockEmailTemplate({ category: 'MANUAL' })
      );

      await duplicateEmailTemplate(templateId);

      expect(prismaMock.emailTemplate.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          category: 'MANUAL',
          trigger: null,
          isActive: false,
        }),
      });
    });
  });
});
