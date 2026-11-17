/** Disposable public build output; production wire bodies remain unchanged inside responses. */
export interface PlaygroundSnapshot {
  readonly formatVersion: 1;
  readonly manifest: {
    readonly appVersion: string;
    readonly compilerVersion: string;
    readonly schemaVersion: number;
    readonly sourceDigests: Readonly<Record<string, string>>;
    readonly digest: string;
  };
  readonly projects: readonly PlaygroundProject[];
  readonly fontLicense: string;
}

export interface PlaygroundProject {
  readonly slug: string;
  readonly name: string;
  readonly notice?: string;
  /** API-relative URL (without an initial slash); queries use URLSearchParams encoding. */
  readonly responses: Readonly<Record<string, unknown>>;
  /** Exact production source reads, separate from frozen page response bodies. */
  readonly toolSources: Readonly<
    Record<
      string,
      {
        readonly sourceRevision: string;
        readonly source: { readonly status: "text"; readonly text: string };
        readonly modelRevision?: string;
        readonly notePath?: string;
      }
    >
  >;
}
