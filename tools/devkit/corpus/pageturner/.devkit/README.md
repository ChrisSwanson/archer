# Review fixtures

A fresh sandbox exposes these in Pageturner:

- `diagrams/containers.mmd`: **Checkout from Basket to Dispatch**, a five-step
  walkthrough with messages for Sequence mode; **Checkout and Follow-Up**, two
  emphasis groups with Members.
- The same diagram covers `shop/**`. `snapshotRepo` commits the original
  `shop/orders.ts`, then overlays `after-snapshot/`: courier work was added after
  the diagram baseline, so the real accuracy API reports **stale**.
- `notes/0001-hosted-payment-page.md`: a grounded **Payment Boundary** passage
  highlight and an agent-authored passage discussion. A fresh browser has not
  marked the answer read, so Notifications has an unread item.

The walkthrough, note emphasis and comment sidecars were written through Archer's
application operations. `emphasis.json` is a `set_emphasis` request: sandbox startup
publishes it through `archer emphasis set` after attaching the copied project.
The corpus itself is never modified by sandbox startup.
