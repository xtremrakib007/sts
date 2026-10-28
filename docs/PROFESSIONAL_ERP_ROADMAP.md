# STS / STSB ERP — Professional ERP Roadmap

## Goal

Evolve STSB ERP into a dependable wholesale distribution ERP for a Malaysian trading business. Prioritize accurate order-to-cash operations, stock integrity, delivery execution, financial reconciliation, access control, and reliable auditability. Extend existing modules instead of duplicating them.

This is a delivery plan, not a claim that every listed capability already exists. Mark a capability complete only after implementation, automated tests, and a verified end-to-end workflow.

## Current verified baseline

- Browser-based STSB ERP portal is served at `/portal` on the root `stfm-sales` Hosting project.
- Existing navigation includes Dashboard, Inventory, Sales Orders, Discount Approvals, Invoices, Collections, Dispatch & Delivery, HQ Orders, Transfers, Suppliers, Reports, and Settings.
- A salesman/day-wise orders report and date-filtered delivery top sheet were added in PR #15 and merged after CI passed. Production behavior still needs end-to-end verification.
- Realtime listeners were added earlier for the portal's existing collections, but the UI currently restricts live sync based on role/profile detection. The live path and Firestore rules must be verified after deployment.
- Root GitHub Actions deploys Hosting; it does not automatically deploy Firestore rules.
- There are known gaps to address: profile/role resolution, user and outlet management screens, robust scheduled delivery dates, and verification that all portal reads/writes match the deployed rules and actual data schema.

## P0 — Reliability and security (must precede broad rollout)

1. **Authentication and profile resolution**
   - Resolve the signed-in user's canonical profile consistently; support the intended tenant-prefixed profile and documented legacy fallback.
   - Never silently grant a role or create an admin profile when profile lookup fails.
   - Show a clear access/profile error and log diagnostic details without exposing secrets.
   - Test super-admin, owner-admin, staff, disabled, missing-profile, and signed-out cases.

2. **Authorization and tenant boundaries**
   - Default-deny Firestore rules; validate every collection and operation against the deployed schema.
   - Enforce least privilege by role and, where relevant, assigned outlet/territory.
   - Salespeople see only permitted customers/orders; delivery staff see only assigned deliveries; finance users handle approved financial workflows.
   - Protect role changes, prices, discounts, stock adjustments, payment acceptance, and settings from unauthorized writes.
   - Add emulator tests for both allowed and denied reads/writes. Do not make collections public to fix permission errors.

3. **Operational resilience**
   - Visible connection/sync status, offline/error states, retry behavior, and non-destructive refreshes.
   - Prevent realtime refresh from overwriting unsaved form input.
   - Idempotent actions for order submission, stock movement, collection acceptance, and delivery confirmation.
   - Audit log for sensitive changes: actor, action, entity, timestamp, before/after values where appropriate.
   - Document backup, restore, retention, and incident-response procedures.

## P1 — Core wholesale workflow

4. **Master data**
   - Customer accounts, addresses, contacts, payment terms, credit limits, tax details, price lists, and active/inactive status.
   - Product/SKU catalogue, barcode, unit of measure, case/pack conversion, category, selling price, cost, tax code, reorder level, and status.
   - Outlet/branch master and assignment of customers, staff, inventory locations, and delivery territories.
   - Salesman, delivery-person, vehicle, supplier, and warehouse master screens.
   - Import/export with validation, duplicate detection, and error reports.

5. **Salesman and order management**
   - Salesman-wise, day-wise, customer-wise, outlet-wise and status-wise order views.
   - Order lifecycle: draft → submitted → approved when required → picking → dispatched → delivered/partially delivered/cancelled.
   - Order number, order date, requested delivery date, scheduled delivery date, salesman UID, customer, outlet, line items, quantities, prices, discounts, tax, totals, payment terms, notes, and status history.
   - Capture salesman attribution from authenticated identity, not a freely editable label.
   - Prevent invalid quantities, negative totals, unauthorized discounts, and duplicate submissions.
   - Show outstanding, overdue, partial, cancelled and fulfilled orders distinctly.

6. **Inventory and warehouse control**
   - Stock on hand, available, reserved, in transit, damaged, and returned quantities.
   - Stock ledger with immutable movement records for receiving, picking, delivery, returns, transfers, adjustments and opening balances.
   - Prevent negative stock unless an explicitly authorized policy allows it.
   - Stock counts, variance approvals, batch/expiry tracking where relevant, reorder alerts, and stock valuation.
   - Atomic/transactional updates so an order or transfer cannot double-decrement stock.

7. **Delivery planning and top sheets**
   - A delivery planner for a chosen date that includes **all orders due for delivery**, not just orders created that day.
   - Filter/group by delivery date, salesman, delivery person, route, outlet, status and payment terms.
   - Printable top sheet per delivery person/route with order number, customer, address/contact, item summary, quantities, order value, COD due, credit terms, collection status, delivery status, signature/proof-of-delivery field and exception notes.
   - Summary totals: orders to deliver, delivered, failed/partial, COD expected, COD collected, credit value and outstanding amount.
   - Assignment/reassignment history; prevent completed/cancelled orders from appearing as pending deliveries.
   - Delivery outcomes: delivered, partial delivery, customer unavailable, refused, rescheduled, returned. Capture timestamp and actor; add photo/GPS only if privacy and operational requirements are approved.
   - Daily reconciliation of dispatch quantities, delivered quantities, returns and collections.

8. **Returns and credit notes**
   - Return authorization/reason, returned quantities, condition, stock disposition, approval, credit note and links to original invoice/order.
   - No silent edits to posted invoices or completed stock movements; use reversal/adjustment records.

## P2 — Finance and procurement

9. **Invoices and receivables**
   - Invoice numbering, customer statement, ageing buckets, due dates, partial payments, credit notes, overdue reminders and reconciliation.
   - Link invoice ↔ order ↔ delivery ↔ collection.
   - Separate draft from posted documents; define cancellation and reversal rules.
   - Keep amounts in MYR and make tax treatment configurable and reviewed for Malaysian requirements; do not hard-code tax assumptions.

10. **Collections and cash control**
    - Record cash/bank/approved payment method, amount, reference, collector, timestamp and linked invoices/orders.
    - Separate pending submission, submitted, accepted, rejected and reconciled states.
    - Daily cash collection sheet by salesman/delivery person; expected vs received vs variance.
    - Segregation of duties for collection acceptance and adjustments; audit all changes.

11. **Purchasing and supplier payables**
    - Purchase requests/orders, approval limits, goods received note, supplier invoice matching, supplier returns, payable due dates and supplier statements.
    - Match received quantities to purchase orders; update inventory through a controlled receiving transaction.
    - Track supplier cost and purchase history.

12. **Discounts and credit management**
    - Configurable discount/price override approval thresholds.
    - Customer credit limit and overdue balance checks before order approval.
    - Approval queues with approver, reason, timestamps and decision history.

## P3 — Management and productivity

13. **Professional reporting**
    - Sales by day/week/month, salesman, customer, product, outlet and territory.
    - Order fulfilment and on-time delivery rates; undelivered/overdue orders.
    - Inventory valuation, movement, ageing, low-stock and stock variance.
    - Receivables ageing, collections, cash variance, discounts, returns and gross margin where cost data is reliable.
    - Filters, pagination, export to CSV/XLSX and print/PDF; permission-aware reports.
    - Reconcile dashboard totals to the underlying ledgers.

14. **Workflow and notifications**
    - In-app alerts for new orders, approval requests, low stock, overdue invoices, failed deliveries and collection variances.
    - Notification preferences and delivery/error tracking.
    - Avoid noisy duplicate notifications; use event IDs/idempotency.

15. **Administration**
    - User management, role assignment, outlet/territory assignment, deactivate/reactivate and session controls.
    - Settings history, numbering rules, company profile, document templates, locale/time zone and configurable business day.
    - User and outlet management pages must be based on the actual data schema; do not invent collections or migrate data blindly.

16. **Usability and device support**
    - Responsive desktop/tablet/mobile layout, clear empty/loading/error states, accessible forms, keyboard navigation and consistent confirmation dialogs.
    - Search, sorting, pagination and saved filters on large lists.
    - Local timezone-safe date handling; avoid UTC date slicing for Malaysia-local business dates.
    - Printable branded invoices, delivery sheets, statements and receipts with consistent headers/footers.

## Data and engineering standards

- Establish a documented schema for order IDs, customer IDs, salesman UID, outlet ID, order date, scheduled delivery date, status, line items, amounts and audit fields.
- Use Firestore server timestamps and explicit timezone/date semantics; normalize legacy records with a reviewed migration plan.
- Use transactions or trusted backend functions for stock, totals, approval, invoice posting and collection acceptance when client-only writes cannot guarantee invariants.
- Use pagination and bounded queries; do not load whole collections indefinitely for reports or real-time listeners.
- Subscribe only to data required for the current role/page; clean up listeners on sign-out/page lifecycle.
- Never log credentials, tokens, full payment secrets or unnecessary personal data.
- Validate inputs on both client and server/rules layer; treat client UI restrictions as usability, not authorization.
- Keep generated production assets reproducible from source and test the built output.

## Release gates

Every phase should include:
1. Existing-code/schema review before implementation.
2. Regression tests for expected behavior and unauthorized behavior.
3. Production asset build and test run in CI.
4. Review of Firestore rules against the exact deployed project.
5. Explicit deployment of Hosting and rules as separate steps when both change.
6. A smoke test using separate super-admin and staff accounts.
7. Verification with test data: create order → approve → pick/dispatch → deliver/partial/return → invoice/collect → reconcile.
8. Documented rollback steps and no production data deletion as part of a feature rollout.

## Recommended implementation sequence

1. Fix and test Super Admin profile/role resolution and live-sync status.
2. Verify/deploy Firestore rules safely and test role-based access.
3. Finalize order schema and scheduled delivery date; make the delivery planner/top sheet include all orders due that day.
4. Add user/outlet administration after confirming actual collection schema.
5. Complete stock ledger and order-to-delivery integrity.
6. Complete invoice/collection reconciliation and returns.
7. Add purchasing, credit controls, and management reporting.
8. Finish audit logging, backups/restore testing, performance and device usability.

## Definition of done

A module is not complete just because its screen exists. It must enforce permissions, validate data, preserve audit history, handle loading/empty/error/offline states, pass tests, and work in an end-to-end workflow against the intended Firebase project.
