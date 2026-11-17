export interface Target {
  origin: string;
  ca?: Buffer | string;
  ownerToken: string;
  params: Record<string, string | undefined>;
  credentials: Record<string, { headers: Record<string, string> }>;
}
export function loadRegistries(): Record<string, any>;
export function request(
  target: Target,
  row: Record<string, any>,
  column: string,
  path: string,
  extraHeaders?: Record<string, string | undefined>,
  options?: Record<string, unknown>,
): Promise<any>;
export function probeMatrix(
  target: Target,
  rows: Record<string, any>[],
  options?: { edit?: boolean; profiling?: boolean; columns?: string[] },
): Promise<
  Record<string, Record<string, { status: number; code?: string; observed: string; expected: string; verdict: string }>>
>;
export function probeCrossSite(
  target: Target,
  rows: Record<string, any>[],
  hashDirs: string[],
): Promise<
  Record<
    string,
    { column: string; variant: string; status: number; class: string; code?: string; stateChanged: boolean }[]
  >
>;
export function probeBodyCaps(
  target: Target,
  rows: Record<string, any>[],
  caps: Record<string, unknown>,
): Promise<
  Record<string, { form: string; column: string; limit: number; sent: number; status: number; refused: boolean }[]>
>;
export function run(options: {
  name?: string;
  out?: string;
  editOffRun?: boolean;
}): Promise<{ dir: string; report: any }>;
