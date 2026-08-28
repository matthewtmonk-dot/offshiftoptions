import "server-only";

import { compare, hash } from "bcryptjs";
import { prisma } from "./prisma";
import { ValidationError } from "./tickers";

const MIN_PASSWORD_LENGTH = 10;

export function assertStrongPassword(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new ValidationError("New password must include both letters and numbers.");
  }
}

export async function changePasswordForUser(
  userId: string,
  currentPassword: string,
  newPassword: string,
  confirmPassword: string,
  currentSessionTokenHash: string | null,
) {
  if (newPassword !== confirmPassword) {
    throw new ValidationError("New password and confirmation do not match.");
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const currentValid = await compare(currentPassword, user.passwordHash);
  if (!currentValid) {
    throw new ValidationError("Current password is incorrect.");
  }

  assertStrongPassword(newPassword);

  const sameAsCurrent = await compare(newPassword, user.passwordHash);
  if (sameAsCurrent) {
    throw new ValidationError("New password must be different from your current password.");
  }

  const passwordHash = await hash(newPassword, 10);

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    prisma.session.deleteMany({
      where: {
        userId,
        ...(currentSessionTokenHash ? { tokenHash: { not: currentSessionTokenHash } } : {}),
      },
    }),
  ]);
}
