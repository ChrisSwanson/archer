// A small docs-mode pack shared by the pack tests.
import { tempDir } from "../project/support.ts";

export const front = (fields: Record<string, string>) =>
  `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n---\n`;

/** A small pack that passes every check: the required files, two flows, code its refs name. */
export function packProject(extra: Record<string, string> = {}, mode = 'mode = "docs"\n'): string {
  return tempDir({
    "archer.toml": `version = 1\nname = "Shop"\n${mode}`,
    "src/checkout.ts": "export function placeOrder() {}\nexport const charge = () => 1;\n",
    "src/email/send.ts": "export function sendReceipt() {}\n",
    ".archer/README.md": `${front({ author: "agent", description: "The shop's docs." })}# Shop docs\n\nStart at [the index](index.md).\n`,
    ".archer/intent.md": `${front({ author: "agent", description: "Why the shop exists.", type: "intent", status: "proposed" })}# Intent\n\nSell books.\n`,
    ".archer/use-cases.md": `${front({ author: "agent", description: "What the shop is for.", type: "use-cases", status: "proposed" })}# Use cases\n\n| Case | Job | Intent | Built | Shown by |\n|---|---|---|---|---|\n| Buy a book | I want a book | proposed | yes | [checkout](notes/flows/checkout.md) |\n`,
    ".archer/architecture.md": `${front({ author: "agent", description: "The parts and where the code is.", type: "architecture", status: "built", checked: "0123456789abcdef0123456789abcdef01234567 2026-10-22", refs: "[src/, src/checkout.ts#placeOrder]" })}# Architecture\n\nCheckout is \`src/checkout.ts#placeOrder\`; email is in \`src/email/\`. Pages live in \`notes/scratch/\`.\nDetail: [payments](notes/architecture/payments.md).\n`,
    ".archer/notes/architecture/payments.md": `${front({ author: "agent", description: "How card payments are taken.", type: "architecture", status: "built" })}# Payments\n\nCharged by \`src/checkout.ts#charge\`.\n`,
    ".archer/notes/flows/checkout.md": `${front({ author: "agent", description: "A customer pays for an order and gets a receipt.", type: "user-flow", status: "built", diagrams: "[../../diagrams/flows/checkout.mmd]", "use-cases": "[buy-a-book]" })}# Checkout\n\n## Steps\n\nPay, then the receipt email.\n`,
    ".archer/diagrams/flows/checkout.mmd":
      "%% description: Checkout, from basket to receipt.\nflowchart LR\n  basket[Basket] pay@--> paid[Paid]\n",
    ".archer/diagrams/flows/returns.mmd":
      "%% description: A returned parcel is scanned and refunded.\nflowchart LR\n  scan[Scan] refund@--> refunded[Refunded]\n",
    ...extra,
  });
}
