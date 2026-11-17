---
type: decision
status: accepted
diagrams: [checkout, containers, system-context]
---

# 0001: Take Card Payments on the Provider's Hosted Page

## Context

Pageturner sells books to the public and takes card payments. Handling card numbers ourselves would
put the Storefront, the Shop API and the Shop Database in scope for PCI DSS, which a three-person
team cannot carry.

## Decision

The Shop API creates a payment session with the payment provider and the Storefront redirects the
customer to the provider's hosted payment page. The provider reports the outcome to the Shop API by
webhook (`payment.succeeded` or `payment.failed`), and only then does the order leave Pending Payment.
See the [checkout](../diagrams/checkout.mmd).

## Consequences

- Card details never reach Pageturner; we store only the provider's session reference
  (`PAYMENT.session_ref` in the [data model](../diagrams/data-model.mmd)).
- The customer leaves our site to pay, which costs some conversion on the "Pay on the hosted payment
  page" step of [buying a book](../diagrams/buying-a-book.mmd).
- The webhook is the source of truth. A customer who closes the tab after paying still gets a Paid
  order.
