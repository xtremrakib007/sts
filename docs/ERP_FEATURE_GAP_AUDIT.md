# STS / STSB-ERP Feature-Gap Audit

**Audit date:** 2026-10-27  
**Repository:** `xtremrakib007/sts`  
**Scope:** tracked source on `main`; no live database or production access was used.

## Executive decision

Do **not** add duplicate product, order, collection, delivery, route, attendance, or general report screens: the Sales App already has these modules. The next feature to prioritize is **auditable inventory movement and stock reconciliation**, but implementation must wait until the canonical inventory collection and actual ERP UI are confirmed. A ledger written beside the existing stock path without connecting every stock-changing workflow would create inconsistent stock figures.

## Existing functionality verified in source

| Area | Evidence | Status |
|---|---|---|
| Product catalogue, zone pricing/stock overrides, duplicate product merge | `js/products.js` | Existing Sales App functionality |
| Sales orders and ERP stock lookup | `js/orders.js` | Existing; reads `stsb_inventory`, matches SKU then name, computes available quantity as quantity minus reserved |
| Collections | `js/collections.js` | Existing Sales App module |
| Sales, collection, attendance and outlet reports | `js/reports.js` | Existing reports; not proof of full accounting |
| Sales-to-ERP sync | `STSB-ERP/functions/index.js` | Mirrors orders/collections and syncs user profiles; other sync triggers also exist |
| ERP rules/data paths | `STSB-ERP/firestore.rules` | Rules mention inventory, suppliers, transfers, HQ orders, invoices, deliveries, visits, and other records |
| ERP browser UI in this repository | Recursive tracked-file listing under `STSB-ERP/` | No ERP HTML/JS screen source found in this directory; UI may be deployed from another/private source, so confirm before building one |

## High-priority findings

### P0 — Exposed service-account credential history

The audit documentation says `STSB-ERP/bulk_sync.js` was changed to Application Default Credentials (ADC), but removing a key from the current file does not revoke it or erase it from Git history. Revoke the exposed key in Google Cloud IAM, inspect audit logs, and purge repository history as appropriate. Do not run the bulk sync until ADC is authenticated and has least-privilege read access to `stfm-sales` and write access to `stsb-erp`.

### P1 — Inventory has two competing paths

- `js/orders.js` reads `stsb_inventory`.
- `STSB-ERP/firestore.rules` also defines an unprefixed `inventory` collection.
- Rules for ERP inventory depend on ERP `users/{uid}` role records; Sales App profiles are mirrored to `salesapp_users`, which is not automatically the same identity/authorization source.

Before changing rules or data paths, identify which collection the deployed ERP UI reads and writes, inspect actual stock document shapes, and confirm whether sales reps should read inventory directly. Do not broaden rules just to make a query succeed.

### P1 — Stock correctness is not yet proven end-to-end

The reviewed order code uses a stock cache and computes available quantity as `qty - reservedQty`. Static source review does not prove that order approval, dispatch, returns, transfers, damage, expiry, or manual adjustments atomically update the same stock records. A stock ledger alone would not fix this unless all mutation paths use it.

### P1 — Role permissions are broad for sensitive records

The ERP rules allow `isERPUser()` to write several sensitive collections, including inventory, suppliers, transfers, HQ orders, invoices and configuration. That helper includes admin/sub-admin/super-admin. A least-privilege matrix should be agreed against real staff duties before narrowing rules, because changing authorization without matching UI workflows can lock out legitimate operations.

### P1 — Financial reconciliation is unverified

The Sales App submits collections and syncs them to ERP. The inspected code does not establish that all deployments enforce unique collection idempotency, immutable reconciled receipts, daily cash/bank close, and server-validated financial totals. Do not call existing sales reports a full accounting system.

## Roadmap — no duplicate feature screens

### Phase 1: canonical stock contract and movement workflow

1. Confirm canonical collection (`stsb_inventory` vs `inventory`), units, SKU/product identifiers, zone/warehouse model, and meanings of `qty` and `reservedQty`.
2. Trace every stock-changing path: goods receipt, order approval/reservation, dispatch, cancellation/release, customer return, supplier return, transfer, damage/expiry, physical count, and adjustment.
3. Implement trusted server-side transactional stock operations with an idempotency key. Reject invalid/negative quantities and stale updates; never accept a client-supplied balance as authoritative.
4. Record append-only movement entries with product/SKU, quantity/unit, from/to location, movement type, source reference, reason, actor UID, approver UID when required, and server timestamp. Correct mistakes with reversal entries rather than editing posted movements.
5. Connect all existing stock-changing workflows to that service. Add stock card, reconciliation/count workflow, low-stock list and movement history only in the actual ERP UI location.
6. Test concurrent requests, duplicate retries, order cancellation, cross-zone access and role denials in the Firebase Emulator before deploy.

Movement types should cover opening balance, receipt, dispatch/sale, customer return, supplier return, transfer out/in, damage/expiry, and approved adjustment. This should be one cohesive stock workflow, not several separate stock tables.

### Phase 2: purchasing and suppliers

After Phase 1's stock contract is stable, verify existing UI first; if missing, add supplier profiles, purchase orders, approval, partial goods receipt, supplier invoice, supplier returns/credit notes and payable balances. Every accepted receipt must post stock through the same movement service.

### Phase 3: money controls and reports

- Collection verification, duplicate receipt protection and daily cash/bank reconciliation.
- Receivables ageing and credit-limit alerts if customer credit is used.
- Sales, collections, stock valuation, gross margin, slow-moving/near-expiry stock, rep/delivery/zone performance and exportable reports.
- Use server-validated costs, discounts and totals; document currency and date/time conventions.

### Phase 4: governance and recovery

- Append-only audit trail and approval inbox for price changes, discounts, stock adjustments, returns and write-offs.
- Least-privilege permissions by role and zone.
- Backup/restore runbook with a tested recovery exercise.
- CI checks for security regression, rules emulator tests, production build and generated assets.

## Next concrete engineering action

Before implementing Phase 1, locate/confirm the deployed ERP UI source and map the canonical stock path. Then add one server-validated stock movement service and connect a single workflow end-to-end with tests before migrating the remaining workflows. If the UI lives in a separate/private repository, do not create a second ERP UI in this repo.

## Validation record

- Static source/tree inspection: performed.
- Existing modules and collection-name conflict: identified from tracked source.
- Firebase Emulator tests: **not run**.
- Live Firestore records, IAM status, deployed ERP UI, and production behavior: **not inspected**.
- Deployment: **not performed**.
