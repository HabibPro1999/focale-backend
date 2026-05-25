export const UserRole = {
  SUPER_ADMIN: 0,
  CLIENT_ADMIN: 1,
  SCIENTIFIC_COMMITTEE: 2,
} as const;

export type UserRoleValue = (typeof UserRole)[keyof typeof UserRole];
