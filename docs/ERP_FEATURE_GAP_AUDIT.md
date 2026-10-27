# STS ERP feature-gap and reliability audit

Date: 2026-10-27  
Repository: `xtremrakib007/sts`

## Scope and evidence

This is a static review of tracked source. It is not a live database inspection, an emulator run, or production verification. Existing code must be preserved until the relevant data flow is confirmed.

## Executive decision

Do not add duplicate product, order, collection, delivery, route, attendance, or general report screens. The Sales App already has these modules. The next feature to prioritize is auditable inventory movement and stock reconciliation, but implementation must wait until the canonical inventory collection and actual ERP UI are confirmed. A ledger beside the existing stock path without connecting every stock-changing workflow would create inconsistent stock figures.

## Existing functionality verified in source

- Sales App: product catalogue, zone pricing/stock overrides, duplicate product merge, orders, collections, outlets, attendance, deliveries, routes, tracking, users and reports.
- Sales and collection reports exist in `js/reports.js`; this is not proof of a complete accounting system.
- Sales-to-ERP Cloud Functions in `STSB-ERP/functions/index.js` mirror orders/collections and sync Sales App user profiles to `salesapp_users`.
- Orders UI in `js/orders.js` reads ERP stock from `stsb_inventory`, matches stock by SKU first and product name second, and computes available quantity as quantity minus `reservedQty`.
- `STSB-ERP/firestore.rules` contains rules for both unprefixed ERP collections (for example `inventory`, `suppliers`, `invoices`) and legacy `stsb_*` collections.
- No ERP HTML/JS screen source was found under the tracked `STSB-ERP/` directory. The deployed ERP UI may be in another/private source; confirm before building a new interface.

## Findings requiring action

### P0 — Rotate exposed service-account credentials

The current `STSB-ERP/bulk_sync.js` uses Application Default Credentials (ADC) and chunks writes into 450-item batches. This removes the need to embed service-account private keys in the current script, but does not revoke an exposed key or erase it from Git history.

Required outside this PR:
1. Revoke/delete the exposed service-account key in Google Cloud IAM.
2. Review audit logs for unexpected use.
3. Purge repository history as appropriate after coordinating with collaborators.
4. Configure ADC with least-privilege access to read `stfm-sales` and write `stsb-erp`.
5. Do not run the bulk sync until authentication and permissions are verified.

### P1 — Confirm the canonical inventory collection and authorization contract

The order flow reads `stsb_inventory`, while ERP rules also define `inventory`. Rules for ERP inventory depend on ERP `users/{uid}` role records; Sales App profiles are mirrored to `salesapp_users`, which is not automatically the same identity/authorization source.

Before changing rules or collection names:
- Confirm which collection the live ERP UI reads and writes.
- Inspect production stock document shapes, identifiers, units, zone/warehouse model, and meanings of `qty` and `reservedQty`.
- Confirm whether Sales App staff should read stock directly.
- Do not broaden client rules simply to make a query succeed; prefer a trusted server endpoint for stock reservation/decrement.

### P1 — Prove stock correctness end-to-end

Static source review does not prove that order approval, dispatch, returns, transfers, damage, expiry, or manual adjustments atomically update the same stock records. A ledger alone will not fix this unless all stock mutation paths use it.

Map every stock-changing path before implementation: opening balance, goods receipt, order approval/reservation, dispatch/sale, cancellation/release, customer return, supplier return, transfer out/in, damage/expiry, physical count and approved adjustment.

### P1 — Review broad role permissions

ERP rules allow `isERPUser()` to write several sensitive collections, including inventory, suppliers, transfers, HQ orders, invoices and configuration. That helper includes admin/sub-admin/super-admin. Agree a least-privilege matrix against actual staff duties before narrowing rules; changing authorization without matching UI workflows can lock out legitimate operations.

### P1 — Verify financial reconciliation

Before adding accounting screens, verify end-to-end that:
- Every collection is linked to an order/outlet and has a unique idempotency key.
- A collection cannot be posted twice or silently edited after reconciliation.
- Order totals, approved discounts, inventory movements and receivables use server-validated values.
- Voids, returns, write-offs and stock adjustments require a reason, actor identity and appropriate approval.
- Daily cash close reconciles recorded collection methods and outstanding balances.
- Cross-project sync handles retries, deletions, duplicate events and partial failures safely.

## Roadmap — add only confirmed missing workflows

### Phase 1: canonical stock contract and movement workflow

1. Confirm the canonical collection (`stsb_inventory` vs `inventory`), identifiers, units, zone/warehouse model and stock field meanings.
2. Trace every stock-changing workflow.
3. Implement trusted server-side transactional stock operations with idempotency keys. Reject invalid/negative quantities and stale updates; never trust a client-supplied balance.
4. Record append-only movement entries with SKU/product, quantity/unit, source/destination, movement type, source reference, reason, actor UID, approver UID when required and server timestamp. Correct mistakes with reversal entries rather than editing posted movements.
5. Connect all existing stock-changing workflows to the same service.
6. Add stock card, reconciliation/count workflow, low-stock list and movement history only in the confirmed ERP UI location.
7. Test concurrent requests, duplicate retries, cancellation/release, cross-zone access and role denials in the Firebase Emulator before deployment.

### Phase 2: purchasing and suppliers

After the stock contract is stable, verify existing UI first. If missing, add supplier profiles, purchase orders, approval, partial goods receipt, supplier invoice, supplier returns/credit notes and payable balances. Every accepted receipt must post stock through the same movement service.

### Phase 3: money controls and reports

- Collection verification, duplicate receipt protection and daily cash/bank reconciliation.
- Receivables ageing and credit-limit alerts if customer credit is used.
- Sales, collections, stock valuation, gross margin, slow-moving/near-expiry stock, rep/delivery/zone performance and exportable reports.
- Server-validated costs, discounts and totals, with documented currency and date/time conventions.

### Phase 4: governance and recovery

- Append-only audit trail and approval inbox for price changes, discounts, stock adjustments, returns and write-offs.
- Least-privilege permissions by role and zone.
- Backup/restore runbook with a tested recovery exercise.
- CI checks for security regression, rules emulator tests, production build and generated assets.

## Next concrete engineering action

Confirm the deployed ERP UI source and map the canonical stock path. Then add one server-validated stock movement service and connect one workflow end-to-end with tests before migrating remaining workflows. If the UI lives in a separate/private repository, do not create a second ERP UI in this repository.

## Validation record

- Static source/tree inspection: performed.
- Inventory collection-name conflict and existing modules: identified from tracked source.
- Regression test exists for ADC-based bulk sync and 450-write batching.
- Firebase Emulator tests: not run in this review.
- Live Firestore records, IAM status, deployed ERP UI and production behavior: not inspected.
- Deployment: not performed.
