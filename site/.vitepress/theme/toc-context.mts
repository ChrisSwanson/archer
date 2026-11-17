import type { InjectionKey, ShallowRef } from "vue";
import type { TocState } from "./toc.mts";

export interface TocContext {
  state: ShallowRef<TocState>;
  toggle(id: string): void;
  navigate(id: string): void;
}

export const tocKey: InjectionKey<TocContext> = Symbol("archer-toc");
