---
type: scenario
diagrams: [checkout, order-lifecycle, buying-a-book]
---

# Scenario: The Card Is Declined

Amira has two books in her basket and checks out. The Shop API reserves both copies and saves the
order as Pending Payment, then sends her to the hosted payment page.

1. Her bank declines the card. The payment provider sends `payment.failed` to the Shop API and
   returns Amira to the Storefront with "try another card" ([checkout](../diagrams/checkout.mmd),
   the "card declined" branch).
2. The order moves to Payment Failed and both copies go back on the shelf at once, so another
   customer can buy the last copy ([order lifecycle](../diagrams/order-lifecycle.mmd)).
3. Amira tries a second card. The order returns to Pending Payment and the stock is reserved again;
   if the last copy sold in the meantime, the Storefront says so before she pays.
4. If she does not come back within 24 hours, the order is Cancelled.

What she should feel: a dip at "Pay on the hosted payment page" in
[buying a book](../diagrams/buying-a-book.mmd), and no surprise afterwards. She is never charged for
an order that ends Cancelled.
