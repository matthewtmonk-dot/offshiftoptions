import { hash } from "bcryptjs";
import type { PrismaClient } from "@/generated/prisma/client";

export type BootstrapUserSpec = {
  name: string;
  email: string;
};

export const PRODUCTION_USERS: [BootstrapUserSpec, BootstrapUserSpec] = [
  { name: "Matt", email: "matt@lst.local" },
  { name: "Eric", email: "eric@lst.local" },
];

export type BootstrapUserResult = {
  email: string;
  userId: string;
  created: boolean;
};

export type BootstrapSummary = {
  users: [BootstrapUserResult, BootstrapUserResult];
  conversationId: string;
  conversationCreated: boolean;
};

function lazyPasswordHash(password: string) {
  let cached: Promise<string> | null = null;
  return () => {
    if (!cached) {
      cached = hash(password, 10);
    }
    return cached;
  };
}

async function ensureBootstrapUser(
  prisma: PrismaClient,
  spec: BootstrapUserSpec,
  getPasswordHash: () => Promise<string>,
): Promise<BootstrapUserResult> {
  const existing = await prisma.user.findUnique({ where: { email: spec.email } });
  if (existing) {
    return { email: spec.email, userId: existing.id, created: false };
  }

  const passwordHash = await getPasswordHash();
  const created = await prisma.user.create({
    data: { name: spec.name, email: spec.email, passwordHash },
  });

  return { email: spec.email, userId: created.id, created: true };
}

async function ensureBootstrapConversation(
  prisma: PrismaClient,
  userIds: [string, string],
  title: string,
): Promise<{ conversationId: string; created: boolean }> {
  const [firstUserId, secondUserId] = userIds;
  const existing = await prisma.conversation.findFirst({
    where: {
      AND: [{ members: { some: { userId: firstUserId } } }, { members: { some: { userId: secondUserId } } }],
    },
  });

  if (existing) {
    return { conversationId: existing.id, created: false };
  }

  const created = await prisma.conversation.create({
    data: {
      title,
      type: "PRIVATE",
      members: {
        create: [{ userId: firstUserId }, { userId: secondUserId }],
      },
    },
  });

  return { conversationId: created.id, created: true };
}

/**
 * Safe, idempotent production bootstrap: creates the two initial LST Buddy
 * users and their shared conversation if they do not already exist. Never
 * deletes, resets, or overwrites existing users, passwords, or any other
 * data. Safe to run multiple times against the same database.
 */
export async function runProductionBootstrap(
  prisma: PrismaClient,
  options: { users?: [BootstrapUserSpec, BootstrapUserSpec]; password?: string } = {},
): Promise<BootstrapSummary> {
  const [userASpec, userBSpec] = options.users ?? PRODUCTION_USERS;
  const getPasswordHash = lazyPasswordHash(
    options.password ?? process.env.DEV_SEED_PASSWORD ?? "lstbuddy-dev-only",
  );

  const userA = await ensureBootstrapUser(prisma, userASpec, getPasswordHash);
  const userB = await ensureBootstrapUser(prisma, userBSpec, getPasswordHash);

  const conversation = await ensureBootstrapConversation(
    prisma,
    [userA.userId, userB.userId],
    `${userASpec.name} and ${userBSpec.name}`,
  );

  return {
    users: [userA, userB],
    conversationId: conversation.conversationId,
    conversationCreated: conversation.created,
  };
}
