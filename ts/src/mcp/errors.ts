// MCP wire mapping only; domain codes and messages are shared by every adapter.
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  type OperationError,
  toolError as operationError,
  serviceError as operationServiceError,
  type ErrorCode,
} from "../application/errors.ts";
export { ERROR_CODES, MAX_ECHO, quoted, type ErrorCode } from "../application/errors.ts";
export function toMcpError(error: OperationError): McpError {
  const mapped = new McpError(error.code, error.message, error.data);
  mapped.message = error.message;
  return mapped;
}
export function toolError(code: ErrorCode, message: string, data: Record<string, unknown> = {}): McpError {
  return toMcpError(operationError(code, message, data));
}
export function serviceError(code: string, message: string, details: Record<string, unknown> = {}): McpError {
  return toMcpError(operationServiceError(code, message, details));
}
