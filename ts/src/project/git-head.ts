// The project page's Git fact: the checked-out branch and short commit when the
// project is in a Git checkout. Git is asked in the background (`refresh`) at
// most once a minute, each command under GitRepository's time and byte bounds;
// a request reads only what Git last said (`current`) and never waits on it.
import { GitRepository } from "../accuracy/git.ts";

export interface GitHead {
  /** Absent when HEAD is detached. */
  readonly branch?: string;
  readonly commit: string;
}

/** Git's answer is kept this long before it is asked again. */
const GIT_HEAD_MAX_AGE_MS = 60_000;

const same = (a: GitHead | null | undefined, b: GitHead | null | undefined): boolean =>
  a === b || (a != null && b != null && a.branch === b.branch && a.commit === b.commit);

export class GitHeadBook {
  /** undefined until Git has answered once; null when this is no Git checkout (or Git cannot say). */
  #head: GitHead | null | undefined;
  #askedAt = -Infinity;
  #asking: Promise<void> | null = null;
  /** Whether anyone read the fact before Git first answered: only then is the first answer news. */
  #readUnknown = false;
  /** For tests: how many times Git was asked. */
  inspections = 0;

  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  current(): GitHead | null | undefined {
    if (this.#head === undefined) this.#readUnknown = true;
    return this.#head;
  }

  /**
   * Asks Git again when its answer is missing or over a minute old; `learned`
   * is called when the answer changed. Git's first answer counts as a change
   * only when `current` was read before it, unanswered. The promise is for tests; it never rejects.
   */
  refresh(learned: () => void = () => {}): Promise<void> {
    if (this.#asking !== null) return this.#asking;
    if (this.now() - this.#askedAt < GIT_HEAD_MAX_AGE_MS) return Promise.resolve();
    this.#askedAt = this.now();
    this.inspections++;
    const before = this.#head;
    this.#asking = this.#ask()
      .then((head) => {
        this.#head = head;
        if (before === undefined ? this.#readUnknown : !same(before, head)) {
          try {
            learned();
          } catch {
            /* A publication failure must not reject this background refresh. */
          }
        }
      })
      .finally(() => {
        this.#asking = null;
      });
    return this.#asking;
  }

  async #ask(): Promise<GitHead | null> {
    try {
      if ((await GitRepository.workTree(this.root)) !== true) return null;
      return await (await GitRepository.open(this.root)).head();
    } catch {
      return null;
    }
  }
}
