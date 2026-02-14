/// <reference types="node" />
/**
 * Script to create a super admin user
 * Run with: bun scripts/create-super-admin.ts
 */
import { createUser } from "../src/modules/identity/users.service.js";
import { UserRole } from "../src/modules/identity/permissions.js";
import { prisma } from "../src/database/client.js";

// ============================================================================
// CONFIGURATION - Read from environment variables
// ============================================================================
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_NAME = process.env.ADMIN_NAME || "Super Admin";

async function main() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error(
      "Usage: ADMIN_EMAIL=... ADMIN_PASSWORD=... bun scripts/create-super-admin.ts",
    );
    process.exit(1);
  }

  console.log("Creating super admin user...");
  console.log("  Email:", ADMIN_EMAIL);
  console.log("  Name:", ADMIN_NAME);

  // Check if user already exists
  const existing = await prisma.user.findUnique({
    where: { email: ADMIN_EMAIL },
  });

  if (existing) {
    console.log("\n❌ User with this email already exists!");
    console.log("  ID:", existing.id);
    console.log(
      "  Role:",
      existing.role === UserRole.SUPER_ADMIN ? "SUPER_ADMIN" : "CLIENT_ADMIN",
    );
    process.exit(1);
  }

  // Create super admin
  const user = await createUser({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    name: ADMIN_NAME,
    role: UserRole.SUPER_ADMIN,
  });

  console.log("\n✅ Super admin created successfully!");
  console.log("  ID:", user.id);
  console.log("  Email:", user.email);
  console.log("  Name:", user.name);
  console.log(
    "  Role:",
    user.role === UserRole.SUPER_ADMIN ? "SUPER_ADMIN" : "CLIENT_ADMIN",
  );

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("\n❌ Failed to create super admin:", error.message);
  await prisma.$disconnect();
  process.exit(1);
});
