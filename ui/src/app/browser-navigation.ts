import { EMPTY_SEARCH, type SearchState } from "./file-index";

/** Navigation chooses a new place; filter editing refines the place already open. */
export type BrowserChangeIntent = "query" | "scope" | "filter";

export function browserNavigationState(
  project: string | null,
  folder: string | null,
  previous: SearchState,
): SearchState {
  return {
    ...EMPTY_SEARCH,
    projects: project === null ? [] : [project],
    folder: folder === "" ? null : folder,
    sort: previous.sort,
  };
}

export function editBrowserFilters(state: SearchState, patch: Partial<SearchState>): SearchState {
  const changedProject =
    patch.projects !== undefined &&
    (patch.projects.length !== state.projects.length ||
      patch.projects.some((slug, index) => slug !== state.projects[index]));
  return { ...state, ...patch, ...(changedProject ? { folder: null } : {}) };
}
