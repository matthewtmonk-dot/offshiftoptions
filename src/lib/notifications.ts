import "server-only";

import type { NotificationType } from "@/generated/prisma/enums";
import { prisma } from "./prisma";

export type NotificationPayload = {
  recipientId: string;
  actorId?: string;
  type: NotificationType;
  title: string;
  body: string;
  href?: string;
};

export type NotificationDeliveryResult = {
  provider: string;
  status: "delivered" | "skipped";
  reason?: string;
};

export interface NotificationDeliveryProvider {
  deliver(payload: NotificationPayload): Promise<NotificationDeliveryResult>;
}

export class InAppNotificationProvider implements NotificationDeliveryProvider {
  async deliver(payload: NotificationPayload): Promise<NotificationDeliveryResult> {
    await prisma.notification.create({
      data: payload,
    });

    return { provider: "in-app", status: "delivered" };
  }
}

export class WebPushNotificationProvider implements NotificationDeliveryProvider {
  async deliver(): Promise<NotificationDeliveryResult> {
    return {
      provider: "web-push",
      status: "skipped",
      reason: "Web Push is prepared but disabled until HTTPS hosting and VAPID keys are configured.",
    };
  }
}

export async function notifyInApp(payload: NotificationPayload) {
  const provider = new InAppNotificationProvider();
  return provider.deliver(payload);
}
