---
type: decision
status: accepted
---
# Auth design

The login path keeps the token server-side.

## Login flow

```mermaid
flowchart LR
  user["User"] e1@--> api["API"]
  api e2@--> store[("Session store")]
```

The second view of the same flow, from the API's side:

```mermaid
sequenceDiagram
  participant A as API
  participant S as Store
  A->>S: put session
```

## Tokens

```mermaid
%% archer-id: refresh
flowchart TB
  old["Old token"] r1@--> new["New token"]
```

- A diagram nested in a list is drawn, and read only:

  ```mermaid
  flowchart LR
    x["X"]
  ```

## Broken

```mermaid
flowchart LR
  a[A] --> b[B]
```

A code block that is not Mermaid stays code:

```ts
const token = "server-side";
```
