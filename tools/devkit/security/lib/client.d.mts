export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
  body: string;
  bytes: Buffer;
  error?: string;
}
export interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  ca?: Buffer | string;
  timeoutMs?: number;
  declaredLength?: number;
  servername?: string;
  chunked?: boolean;
}
export function redact(value: unknown, secrets?: Map<string, string>): string;
export function send(url: string, options?: SendOptions): Promise<Reply>;
export interface OpenStream {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  ended: Promise<number>;
  endedAt(): number | null;
  close(): void;
  error?: string;
}
export function openStream(
  url: string,
  options?: { headers?: Record<string, string>; ca?: Buffer | string },
): Promise<OpenStream>;
export function sandboxRecord(name: string): Promise<Record<string, any>>;
export function cookiePair(response: { headers: Record<string, unknown> }): string | null;
export function errorCode(response: { body: string }): string | undefined;
