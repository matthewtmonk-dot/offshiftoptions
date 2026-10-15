"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { signInWithPassword } from "@/lib/auth";
import { clientIpFromHeaders, emailLoginThrottle, ipLoginThrottle } from "@/lib/login-throttle";

/** bcrypt only reads the first 72 bytes; anything this long is not a real password attempt. */
const MAX_PASSWORD_LENGTH = 1024;

export async function signInAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase().slice(0, 254);
  const password = String(formData.get("password") ?? "");
  const emailKey = `email:${email}`;
  const ipKey = `ip:${clientIpFromHeaders(await headers())}`;

  // Refuse BEFORE any password hashing when this email or this address has failed too often
  // recently - the login emails are public (the repository is public), so guessing must be rate
  // limited. See login-throttle.ts for the policy and its limits.
  if (emailLoginThrottle.check(emailKey).blocked || ipLoginThrottle.check(ipKey).blocked) {
    redirect("/login?error=throttled");
  }

  const user = password.length > MAX_PASSWORD_LENGTH ? null : await signInWithPassword(email, password);

  if (!user) {
    emailLoginThrottle.recordFailure(emailKey);
    ipLoginThrottle.recordFailure(ipKey);
    redirect("/login?error=invalid");
  }

  emailLoginThrottle.recordSuccess(emailKey);
  redirect("/dashboard");
}
