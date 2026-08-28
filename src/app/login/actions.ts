"use server";

import { redirect } from "next/navigation";
import { signInWithPassword } from "@/lib/auth";

export async function signInAction(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const user = await signInWithPassword(email, password);

  if (!user) {
    redirect("/login?error=invalid");
  }

  redirect("/dashboard");
}
