export type Visibility = "PRIVATE" | "SHARED";
export type InheritedVisibility = Visibility | "INHERIT";

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

export function resolveInheritedVisibility(visibility: InheritedVisibility, parentVisibility: Visibility): Visibility {
  return visibility === "INHERIT" ? parentVisibility : visibility;
}

export function canReadInheritedRecord(
  viewerId: string,
  ownerId: string,
  visibility: InheritedVisibility,
  parentVisibility: Visibility,
): boolean {
  return canReadRecord(viewerId, ownerId, resolveInheritedVisibility(visibility, parentVisibility));
}

export function assertCanReadInheritedRecord(
  viewerId: string,
  ownerId: string,
  visibility: InheritedVisibility,
  parentVisibility: Visibility,
): void {
  if (!canReadInheritedRecord(viewerId, ownerId, visibility, parentVisibility)) {
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
