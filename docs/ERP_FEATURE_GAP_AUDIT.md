# STS ERP feature-gap and reliability audit

Date: 2026-10-27
Repository: `xtremrakib007/sts`

## Scope and evidence

This is a static review of the current `main` source. It is not a live database inspection, an emulator run, or a production verification. Existing code must be preserved until the relevant data flow is confirmed.

## Existing functionality found (do not duplicate without further review)

- Sales App: product catalog and zone-specific price/stock overrides, orders, collections, outlets, attendance, deliveries, routes, tracking, users and reports.
- ERP data model/rules: inventory, suppliers, stock transfers, HQ orders, invoices, discounts, deliveries, visits, attendance, config and user locations.
- Sales-to-ERP Cloud Functions: mirrors orders and collections and syncs Sales App user profiles to `salesapp_users`.
- Orders UI reads ERP stock from `stsb_inventory`, matching stock by SKU first and product name second.
- Root `STSB-ERP/firestore.rules` contains rules for both unprefixed ERP collections (for example `inventory`, `suppliers`, `invoices`) and legacy `stsb_*` collections.

## Findings requiring action

### P0 — Remove and rotate exposed service-account credentials

The current `STSB-ERP/bulk_sync.js` contained a hard-coded ERP service-account private key and loaded a local Sales service-account JSON. The script has been changed on this branch to use Application Default Credentials (ADC), and it chunks writes to stay below Firestore batch limits.

**Required outside this PR:** revoke/delete the exposed service-account key in Google Cloud IAM, create a replacement only if needed, and review audit logs. Removing the key from the latest file does not erase it from Git history. Do not run the script until ADC is authenticated and has the minimum required access to read `stfm-sales` and write `stsb-erp`.

### P1 — Verify inventory collection and authorization contract

The order flow reads `stsb_inventory`, while ERP rules also define a separate `inventory` collection. The rules restrict `stsb_inventory` to `isERPUser()`, based on a role document in the ERP project's `users` collection. Sales App staff are mirrored to `salesapp_users`, not necessarily `users`.

Before changing rules or collection names, confirm which collection the live ERP UI writes to, where production stock records actually live, and whether Sales App staff are intended to read inventory directly. Prefer a trusted server endpoint for stock reservation/decrement; never broaden client rules simply to make reads work.

### P1 — Verify cross-project sync integrity

Sales sync functions write root-level `orders` and `collections` into the ERP project. The ERP also has zone-scoped rules and legacy prefixed collections. Confirm the ERP UI reads the same canonical documents and that retries, deletions, duplicate events and partial failures are handled safely before making financial reports authoritative.

### P1 — Financial controls

Before adding more accounting screens, verify these controls end-to-end:
- Every collection is linked to an order/outlet and has a unique idempotency key.
- A collection cannot be posted twice or silently edited after reconciliation.
- Order totals, approved discounts, inventory movements and receivables use server-validated values.
- Voids, returns, write-offs and stock adjustments require a reason, actor identity and approval where appropriate.
- Daily cash close can be reconciled against recorded collection methods and outstanding balances.

### P2 — Feature additions only after gap confirmation

Potential additions, if not already implemented in the ERP UI:
1. Purchase receiving against supplier/HQ purchase orders.
2. Stock ledger with immutable movement records, stock counts, damage/expiry and transfers.
3. Customer credit limits, receivables ageing and collection reconciliation.
4. Audit log and approval inbox for discounts, stock adjustments, returns and write-offs.
5. Management dashboard with sales, gross margin, stock valuation and overdue balances.
6. Tested backup-and-restore runbook.

## Implementation order

1. Rotate the exposed service-account key and verify ADC IAM access.
2. Map canonical collection paths and owners across `stfm-sales` and `stsb-erp`.
3. Add emulator tests for owner/admin/sub-admin/sales-rep/delivery roles and cross-zone access.
4. Test sync idempotency, inventory reservation, collection posting and reconciliation.
5. Implement only the confirmed missing workflow, with regression tests.
6. Deploy rules/functions only after tests pass and the target Firebase project is explicitly verified.

## Validation status

- Static code inspection: performed.
- Regression test added for ADC-only bulk sync and 450-write batching.
- Firebase Emulator: not run in this review.
- Live database / IAM / production behavior: not inspected.
- Deployment: not performed.
