import "server-only";

import { compare, hash } from "bcryptjs";
import { randomBytes, createHmac } from "node:crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "./prisma";

export const SESSION_COOKIE = "lst_buddy_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** Exported for tests. Fails closed: the repository is public, so the development fallback is
 * publicly known - in production a missing secret must stop sign-in/session checks, never silently
 * use it. */
export function resolveSessionSecret(secret: string | undefined, nodeEnv: string | undefined): string {
  if (secret) return secret;
  if (nodeEnv === "production") {
    throw new Error("LST_SESSION_SECRET is required in production.");
  }
  return "local-development-session-secret";
}

function getSessionSecret() {
  return resolveSessionSecret(process.env.LST_SESSION_SECRET, process.env.NODE_ENV);
}

function hashSessionToken(token: string) {
  return createHmac("sha256", getSessionSecret()).update(token).digest("hex");
}

function sessionExpiresAt() {
  return new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
}

// A real bcrypt hash of a random value, computed once. Comparing against it when the email is unknown
// makes "no such user" cost the same as "wrong password", so response time can't reveal which
// emails exist.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash() {
  dummyHashPromise ??= hash(randomBytes(16).toString("hex"), 10);
  return dummyHashPromise;
}

export async function signInWithPassword(email: string, password: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });

  if (!user) {
    await compare(password, await getDummyHash());
    return null;
  }

  const validPassword = await compare(password, user.passwordHash);
  if (!validPassword) {
    return null;
  }

  const token = randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: sessionExpiresAt(),
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return user;
}

/**
 * Memoized per-request with React's `cache()` - the root layout (for theme resolution),
 * the authenticated app layout, and individual pages can all call this without issuing
 * duplicate session/user queries for the same request.
 */
export const getCurrentUser = cache(async () => {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (!token) {
    return null;
  }

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: { include: { settings: { select: { appearance: true } } } } },
  });

  if (!session || session.expiresAt < new Date()) {
    if (session) {
      await prisma.session.delete({ where: { id: session.id } });
    }
    return null;
  }

  return session.user;
});

export async function requireCurrentUser() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  return user;
}

export async function getCurrentSessionTokenHash() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  return token ? hashSessionToken(token) : null;
}

export async function signOut() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (token) {
    await prisma.session.deleteMany({
      where: { tokenHash: hashSessionToken(token) },
    });
  }

  cookieStore.delete(SESSION_COOKIE);
}
