---
author: agent
description: What Archer is for, each job tied to the diagram that shows it and the code that does it. Draft.
type: use-cases
status: proposed
confirmed: 2026-10-22 0.4.0 rows Teach-back, Handover capsule (decided 2026-10-22)
checked: 0.4.0 2026-10-22
refs: [ts/src/docs/pack.ts, ts/src/service/emphasis.ts, ts/src/application/index.ts, ts/src/comments/agent.ts, ts/src/service/watch.ts, ts/src/accuracy/compare.ts, ts/src/accuracy/stale.ts, ts/src/project/project.ts, ts/src/export/, ts/src/mcp/server.ts]
---
# Use cases

The jobs Archer serves, for its [intent](intent.md). **Intent** asks whether we want it (proposed
until confirmed). **Built** asks what the code does today. Nine came from a list
agreed to on 2026-10-22, but the wording is the agent's: rows stay proposed unless confirmed. The
first four were chosen to build (2026-10-22): how does X work, show understanding first, keep the docs
current, now versus intended.

```mermaid
%% archer-id: use-case-map
flowchart LR
  %% archer-key dotted: No flow drawn yet
  subgraph understand[Understand]
    how[How does X work?]:::partly
    onboard[Onboard to a repo]:::partly
    teach[Teach-back]:::planned
    replay[Replay an incident]:::planned
  end
  subgraph agree[Agree]
    show[Show understanding first]:::partly
    sketch[Sketch an idea together]:::built
    challenge[Challenge this design]:::partly
    nowvs[Now versus intended]:::planned
  end
  subgraph change[Change]
    prdelta[Architecture delta in a PR]:::partly
    current[Keep the docs current]:::partly
    assert[Narrow assertions]:::planned
  end
  subgraph handover[Hand over]
    capsule[Handover capsule]:::planned
    phone[Glance from a phone]:::partly
  end
  present[Present, emphasis, selection]:::flow
  comments[Comment round trip]:::flow
  live[Agent write to live update]:::flow
  todo[Flow to draw]
  how f1@--> present
  show f2@--> present
  show f3@--> comments
  challenge f4@--> comments
  sketch f5@--> live
  onboard g1@-.-> todo
  teach g2@-.-> todo
  replay g3@-.-> todo
  nowvs g4@-.-> todo
  prdelta g5@-.-> todo
  current g6@-.-> todo
  assert g7@-.-> todo
  capsule g8@-.-> todo
  phone g9@-.-> todo
  classDef built fill:#2e7d32,stroke:#1b5e20
  classDef partly fill:#f9a825,stroke:#f57f17
  classDef planned fill:#9e9e9e,stroke:#616161
  classDef flow fill:#1565c0,stroke:#0d47a1
```

| Case | When…, I want…, so… | Intent | Built | Shown by · code |
|---|---|---|---|---|
| How does X work? | I ask how a feature works; see the existing diagram, path emphasised; no prose | proposed | partly: presenting, emphasis and `docs_index` routing | present · `ts/src/docs/pack.ts#route` |
| Onboard to a repo | I open an unfamiliar repo; a tour where each claim points at code; I can trust it | proposed | partly | — · `ts/src/application/index.ts` |
| Teach-back | Both ways: I explain a flow back on the diagram and the agent checks it, or the agent explains and I check; see where we differ | confirmed 2026-10-22 | no | — |
| Replay an incident | Something broke; replay the failing path step by step; see where | proposed | no | — · `ts/src/service/emphasis.ts` |
| Show understanding first | I ask for a change; the agent shows how it sees that part and waits; I correct it before code | proposed | partly: presenting and comments, not the wait | [present](diagrams/flows/present-emphasis-selection.mmd), [comments](diagrams/flows/comment-round-trip.mmd) · `ts/src/comments/agent.ts` |
| Sketch an idea together | Thinking out loud; a one-off picture we change fast; settle it without a doc | proposed | yes | [live update](diagrams/flows/agent-write-live-update.mmd) · `ts/src/service/watch.ts` |
| Challenge this design | I have a design; the agent argues against it on the diagram; risks surface early | proposed | partly | [comments](diagrams/flows/comment-round-trip.mmd) |
| Now versus intended | Built and designed differ; see both and the difference; decide which is wrong | proposed | no | — |
| Architecture delta in a PR | I review a PR; changed diagrams before and after; review structure too | proposed | partly: one diagram at two commits | — · `ts/src/accuracy/compare.ts#compareDiagramCommits` |
| Keep the docs current | Code changes; the agent fixes or re-checks the docs on it; answers stay trustworthy | proposed | partly: staleness, pack health | write · `ts/src/accuracy/stale.ts#listStaleDiagrams` |
| Narrow assertions | A rule matters (content writes stay in the folder); stated once and checked on change | proposed | no | — · `ts/src/project/project.ts#writeConfined` |
| Handover capsule | I hand work over; a generated note linking the relevant docs and diagrams; the next agent starts aligned | confirmed 2026-10-22 | no | — |
| Glance from a phone | Away from the desk; a readable picture; I can follow along | proposed | partly | — · `ts/src/export/`, `ts/src/mcp/server.ts` |

## Decided (2026-10-22)

- First slice: how does X work, show understanding first, keep the docs current, now versus
  intended.
- Teach-back goes both ways; a handover capsule is a generated note, no new format.
