export type Visibility = "PRIVATE" | "SHARED";

export class AuthorizationError extends Error {
  constructor(message = "You are not allowed to read this record.") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export function canReadRecord(viewerId: string, ownerId: string, visibility: Visibility): boolean {
  return viewerId === ownerId || visibility === "SHARED";
}

export function assertCanReadRecord(viewerId: string, ownerId: string, visibility: Visibility): void {
  if (!canReadRecord(viewerId, ownerId, visibility)) {
    throw new AuthorizationError();
  }
}

export function canMutateRecord(viewerId: string, ownerId: string): boolean {
  return viewerId === ownerId;
}

export function assertCanMutateRecord(viewerId: string, ownerId: string): void {
  if (!canMutateRecord(viewerId, ownerId)) {
    throw new AuthorizationError("You are not allowed to change this record.");
  }
}
