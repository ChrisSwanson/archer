export class AuthoringStoreError extends Error {
  readonly currentReviewRevision?: number;
  constructor(
    readonly code: string,
    message: string,
    currentReviewRevision?: number,
  ) {
    super(message);
    this.name = "AuthoringStoreError";
    if (currentReviewRevision !== undefined) this.currentReviewRevision = currentReviewRevision;
  }
}
