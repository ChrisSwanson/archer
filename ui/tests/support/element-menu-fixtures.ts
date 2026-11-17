const CONTEXT = `C4Context
title Context
Person(user, "Shopper")
System(shop, "Shop")
System_Ext(pay, "Payments")
Rel(user, shop, "buys from")
Rel(shop, pay, "charges")
`;
const CONTAINERS = `C4Container
title Containers
Person(user, "Shopper")
System_Boundary(shop, "Shop") {
  Container(web, "Web", "React")
  Container(api, "API", "Node")
  ContainerDb(db, "Orders DB", "Postgres")
}
System_Ext(mail, "Mail")
Rel(user, web, "uses")
Rel(web, api, "calls")
Rel(api, db, "reads")
Rel(api, mail, "sends")
`;
const DEPLOY = `---
status: proposed
---
# Deploy

\`\`\`mermaid
%% archer-id: deploy
flowchart LR
  api[API]:::container
  queue[Jobs]:::container
  worker[Worker]:::container
  api e1@--> queue
  queue e2@--> worker
\`\`\`
`;

/** Six more diagrams that each open `shop` with eleven boxes: enough to reach the 5-source / 60-box limit (A13). */
function partsOf(n: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 1; i <= n; i++) {
    const boxes = Array.from({ length: 11 }, (_, j) => `  Container(p${i}c${j}, "Part ${i}.${j}", "Node")`).join("\n");
    const rels = Array.from({ length: 10 }, (_, j) => `Rel(p${i}c${j}, p${i}c${j + 1}, "calls")`).join("\n");
    files[`.archer/diagrams/part${i}.mmd`] =
      `C4Container\ntitle Part ${i}\nPerson(user, "Shopper")\nSystem_Boundary(shop, "Shop") {\n${boxes}\n}\nRel(user, p${i}c0, "uses")\n${rels}\n`;
  }
  return files;
}

export function elementMenuFiles(parts = 0): Record<string, string> {
  const views = [
    `[[views]]\nid = "context"\nkind = "c4"\ntitle = "Context"\nsource = ".archer/diagrams/context.mmd"\n`,
    `[[views]]\nid = "containers"\nkind = "c4"\ntitle = "Containers"\nsource = ".archer/diagrams/containers.mmd"\n`,
    ...Array.from(
      { length: parts },
      (_, i) =>
        `[[views]]\nid = "part${i + 1}"\nkind = "c4"\ntitle = "Part ${i + 1}"\nsource = ".archer/diagrams/part${i + 1}.mmd"\n`,
    ),
  ];
  return {
    "archer.toml": `version = 1\nname = "Shop"\n\n${views.join("\n")}`,
    ".archer/diagrams/context.mmd": CONTEXT,
    ".archer/diagrams/containers.mmd": CONTAINERS,
    ".archer/notes/deploy.md": DEPLOY,
    "README.md": "# Shop\n\nA small shop.\n",
    ...partsOf(parts),
  };
}

/** Compiler-valid extremes shared by the browser and real-service controller coverage. */
export function extremeMenuProject(): { files: Record<string, string>; longTitle: string } {
  const longTitle = `${"注文の処理 😀 ".repeat(14)}Distinct Ending`;
  const corpus = elementMenuFiles(14);
  corpus["archer.toml"] = corpus["archer.toml"]!.replace('title = "Part 1"', `title = "${longTitle}"`)
    .replace('title = "Part 2"', 'title = "Shared Title"')
    .replace('title = "Part 3"', 'title = "Shared Title"');
  corpus[".archer/diagrams/part1.mmd"] =
    `%% description: A detailed description of the order processing source. ${"More about its runtime. ".repeat(10)}\n${corpus[".archer/diagrams/part1.mmd"]}`;
  corpus["archer.toml"] +=
    '\n[[views]]\nid = "neighbours"\nkind = "freeform"\ntitle = "Neighbours"\nsource = ".archer/diagrams/neighbours.mmd"\n';
  corpus[".archer/diagrams/neighbours.mmd"] =
    `flowchart LR\n  shop[Shop]:::system\n${Array.from({ length: 14 }, (_, i) => `  n${i}[Neighbour ${i}]:::container\n  shop e${i}@--> n${i}\n`).join("")}`;
  return { files: corpus, longTitle };
}
