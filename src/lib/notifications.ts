import "server-only";

import type { NotificationType } from "@/generated/prisma/enums";
import { prisma } from "./prisma";

/**
 * Which notification types the /notifications page (and its unread count/mark-all-read action)
 * actually surfaces. Deliberately an allowlist, not a denylist of MESSAGE/RECOMMENDATION - a
 * future NotificationType added to the schema stays hidden here until someone deliberately
 * decides it belongs on this page, rather than silently appearing by default.
 *
 * MESSAGE is excluded because Chat now owns that experience end-to-end: its own sidebar badge
 * (getUnreadChatCount, backed by ChatMessageRead) and its own explicit Mark read action already
 * give a more contextual, per-conversation read state than a bell-icon list ever could - showing
 * "Eric sent you a message" here too was pure duplication of what Chat already shows.
 *
 * RECOMMENDATION is excluded for the same reason once a recommendation also posts a structured
 * message into the sender/recipient's shared conversation (see createRecommendationForUser) -
 * the recipient sees the new recommendation in Chat, so a second bell notification is redundant.
 *
 * COMMENT (on a watchlist/Research item or a Recommendation) and REACTION have no other home
 * today - removing them from this page would silently orphan that discoverability, so they stay.
 * TRADE and SYSTEM are declared in the schema but nothing currently creates them; kept visible so
 * a future feature can start using them without also needing to touch this list.
 */
export const NOTIFICATIONS_PAGE_VISIBLE_TYPES: NotificationType[] = ["COMMENT", "REACTION", "TRADE", "SYSTEM"];

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
