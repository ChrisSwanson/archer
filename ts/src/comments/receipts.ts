// Browser and service share operation admission and validation; only hashing is Node-specific.
import { createHash } from "node:crypto";
import { canonicalJson } from "../../../shared/comment-receipts.mts";
import type { CommentOperation, SubmitOperation } from "./contract.ts";
export * from "../../../shared/comment-receipts.mts";

/** The digest an identity is bound to: the operation, the caller's realm and the validated payload. */
export function operationDigest(
  operation: CommentOperation | SubmitOperation,
  realm: string,
  payload: unknown,
): string {
  return createHash("sha256")
    .update(canonicalJson({ v: 1, operation, realm, payload }))
    .digest("hex");
}
