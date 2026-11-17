// A present the store refuses changes nothing (ADR 0036 §14, O1, A11): the exploration counters it moves
// (the generation, the presents-versus-reader order) are put back with the presentation, so the agent
// still reads the reader's exploration and the next present takes the generation it would have taken.
import { afterEach, expect, test } from "vitest";
import { ProjectState } from "../../src/service/project-state.ts";
import { AccountStateStore, PersistenceError, type RecoveryRecord } from "../../src/state/account.ts";
import { cleanUp, tempDir, write } from "./support.ts";

afterEach(cleanUp);

const SHOP = { element: "shop", source: "containers" },
  API = { element: "api", source: "deploy" };

/** The real store, until it is told to refuse every save, as a full or read-only disk would. */
class RefusingStore extends AccountStateStore {
  refusing = false;
  override save(record: RecoveryRecord, sources: Parameters<AccountStateStore["save"]>[1]): void {
    if (this.refusing) throw new PersistenceError("io_error", "the disk refused the write");
    super.save(record, sources);
  }
}

function explorationProject(): string {
  const root = tempDir("archer-proj-");
  write(
    root,
    ".archer/context.mmd",
    'C4Context\nPerson(user, "Shopper")\nSystem(shop, "Shop")\nRel(user, shop, "buys from")\n',
  );
  write(
    root,
    ".archer/containers.mmd",
    'C4Container\nPerson(user, "Shopper")\nSystem_Boundary(shop, "Shop") {\n  Container(web, "Web")\n  Container(api, "API")\n}\nRel(user, web, "uses")\nRel(web, api, "calls")\n',
  );
  write(
    root,
    ".archer/deploy.mmd",
    "flowchart LR\n  api[API]:::container\n  queue[Jobs]:::container\n  api e1@--> queue\n",
  );
  return root;
}

test("a present refused at persist leaves the exploration order, its generation and the reading as they were", async () => {
  const store = new RefusingStore(tempDir());
  const state = await ProjectState.open(
    explorationProject(),
    () => "http://localhost/p/",
    () => {},
    { store },
  );
  try {
    state.present("context", undefined, undefined, undefined, [SHOP]);
    expect(state.context().exploration).toMatchObject({ origin: "presentation", generation: 1 });
    // The reader adds a frame after the present: theirs is the exploration the agent reads.
    const revision = state.envelope("context")!.revision;
    expect(state.postReaderExploration({ viewId: "context", revision, expand: [SHOP, API] })).toEqual({ ok: true });
    expect(state.postReading({ viewId: "context", id: "ask", step: 2 })).toEqual({ ok: true });
    const context = state.context(),
      bootstrap = state.bootstrap();
    expect(context.exploration).toMatchObject({ origin: "reader" });

    store.refusing = true;
    expect(() => state.present("context", "Again", undefined, undefined, [SHOP, API])).toThrow(PersistenceError);
    expect(state.context()).toEqual(context);
    expect(state.bootstrap()).toEqual(bootstrap);

    // The refused present took no generation: the next one is the second.
    store.refusing = false;
    state.present("context", undefined, undefined, undefined, [SHOP, API]);
    expect(state.context().exploration).toMatchObject({ origin: "presentation", generation: 2 });
  } finally {
    state.close();
  }
});
