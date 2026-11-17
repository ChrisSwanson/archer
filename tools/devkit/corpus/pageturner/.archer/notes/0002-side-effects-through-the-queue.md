---
type: decision
status: accepted
diagrams: [containers, deployment]
---

# 0002: Send Emails and Book Couriers from a Worker

## Context

After a payment succeeds, Pageturner sends a confirmation email and books a parcel collection with
the courier. Both are calls to outside services that are sometimes slow or down, and neither has to
happen before the customer sees "order confirmed".

## Decision

The Shop API puts both on the job queue and returns. A separate worker takes work from the queue,
calls the email service and the courier, and retries with backoff when they fail. See the
[containers](../diagrams/containers.mmd) and the [deployment](../diagrams/deployment.mmd).

## Consequences

- A slow courier API never holds up checkout or the payment webhook.
- The confirmation email can arrive a minute after the confirmation page, which the "Get the
  confirmation email" step of the journey already allows for.
- The queue is another thing to run and watch: it sits in the data group beside the Shop Database.
