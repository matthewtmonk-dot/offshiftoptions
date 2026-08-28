import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const payload = pushSubscriptionSchema.parse(await request.json());

  await prisma.pushSubscription.upsert({
    where: { endpoint: payload.endpoint },
    update: {
      userId: user.id,
      p256dh: payload.keys.p256dh,
      auth: payload.keys.auth,
      userAgent: request.headers.get("user-agent"),
      enabled: true,
    },
    create: {
      userId: user.id,
      endpoint: payload.endpoint,
      p256dh: payload.keys.p256dh,
      auth: payload.keys.auth,
      userAgent: request.headers.get("user-agent"),
    },
  });

  return NextResponse.json({
    status: "stored",
    delivery: "web-push-disabled-until-https-and-vapid",
  });
}
