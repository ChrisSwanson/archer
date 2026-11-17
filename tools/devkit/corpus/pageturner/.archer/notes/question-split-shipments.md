---
type: question
status: open
diagrams: [order-lifecycle, data-model]
---

# Open Question: Should One Order Ship in More Than One Parcel?

Today an order has at most one shipment (`ORDER ||--o| SHIPMENT` in the
[data model](../diagrams/data-model.mmd), and `SHIPMENT.order_id` is unique), and it moves through
Fulfilment, Shipped and Delivered as one piece ([order lifecycle](../diagrams/order-lifecycle.mmd)).

Staff ask to send what is in stock now and the rest when it arrives. That would mean:

- `ORDER ||--o{ SHIPMENT`, with each order line assigned to a shipment;
- an order that is partly shipped: either a new state, or a state per shipment rather than per order;
- one confirmation email per parcel, with its own tracking reference.

Undecided: is a partly shipped order common enough to model, or do we hold the order until every book
is in stock and tell the customer the date up front?
