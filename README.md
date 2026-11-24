# OPS → EFI Pace Integration — Developer Showcase

**Real JavaScript implementation excerpts from an order-to-production automation project.**

This portfolio is a **sanitized, selected code review**, not the complete or newest production deployment. The local October snapshot was used as the source; the live server's later version has not been copied. Production credentials, browser authentication sessions, order records, state files, product mappings, artwork, and client-specific URLs are intentionally omitted.

> **Read before running:** This folder is not an operational integration. Several modules reference other modules, configuration, live systems, and browser sessions that are intentionally omitted. The `npm test` command runs **only isolated, safe data-validation tests**; it does not connect to OPS, Pace, or payment/customer systems.

## Why this project matters

The integration coordinates order information from an online print storefront (OPS) with a production MIS (EFI Pace), transforming data and guarding against ambiguous partial completion. The work illustrates practical JavaScript/Node.js development, stateful orchestration, browser automation with Playwright, data reconciliation, and failure-handling decisions.

## Code tour

| File | Demonstrates |
| --- | --- |
| [`production-cycle.js`](production-cycle.js) | Orchestration, dry-run versus live modes, multi-step order processing, child process handling, bounded cycles, logs, and cycle locking |
| [`ops-order-watcher.js`](ops-order-watcher.js) | Order discovery and checkpoint state using Playwright |
| [`ops-order-reader.js`](ops-order-reader.js) | Extracting and normalizing orders from a legacy web application |
| [`jobpart-reconciler.js`](jobpart-reconciler.js) | Reconciling order products with production job parts and guarding writes |
| [`conversion-lock.js`](conversion-lock.js) | Preventing duplicate conversions through persistent per-order state and exclusive file creation |
| [`post-create-resume.js`](post-create-resume.js) | State-based restart decisions after partial completion |
| [`source-part-map.js`](source-part-map.js) | Validating one-to-one source-part mappings and rejecting ambiguity |
| [`shipment-recovery-guard.js`](shipment-recovery-guard.js) | Preventing duplicate shipment writes if an existing shipment or recovery conflict is found |
| [`dept-id.js`](dept-id.js) | Extracting structured identifiers from PDF job-ticket text |
| [`tests/`](tests/) | Self-contained Node.js tests added for this showcase, using fictitious input data |

## Workflow outline

```text
OPS order discovery
       |
       v
Preflight validation
       |
       v
Job conversion [exclusive lock / state checks]
       |
       v
Job-part reconciliation
       |
       v
Artwork attachment
       |
       v
Shipment preparation and write
       |
       v
Recorded completion or manual review
```

The central controller re-evaluates persisted state between steps instead of blindly repeating a write. It can stop before a write in dry-run mode and routes ambiguous outcomes into manual review.

## Safe tests

With Node.js 18+ installed:

```bash
npm test
npm run check
```

The isolated tests exercise `source-part-map.js` and `shipment-recovery-guard.js` with fictional values. No credentials or external services are required. `npm run check` performs JavaScript syntax checks only; it is not an end-to-end integration test.

## Original vs. portfolio copy

This repository preserves selected modules from an earlier working local snapshot, with documented showcase adaptations:

- Replaced real OPS / Pace hostnames with non-resolving `example.invalid` placeholders.
- Removed operational secrets, customer records, mappings, and server/browser state by **not including** those files.
- Replaced an illustrative PDF ticket department identifier with a fictional example.
- Adjusted **only this portfolio copy's** cycle lock cleanup so a cycle does not remove a lock it failed to acquire.
- Adjusted **only this portfolio copy's** top-level cycle reporting so per-order error/manual-review results produce a nonzero exit status (useful for scheduler monitoring).
- Added standalone, synthetic-data tests and this documentation to help reviewers examine specific behaviors.

**These portfolio edits were not automatically applied to the live integration.** Do not use this repository in production, or infer that every component shown here is from the latest production version.

## Areas I can explain in a code review

- How order state flows through discovery, preflight, conversion, reconciliation, artwork, and shipment creation.
- Why idempotency and recovery states matter when a browser automation process might fail after a remote write.
- How to distinguish a genuinely safe retry from an uncertain write that requires manual inspection.
- How to translate inconsistent product/job data and reject ambiguous mappings instead of silently guessing.
- How to improve observability: explicit exit codes, structured logs, and alerting for orders requiring manual review.

## Confidentiality note

No live website hostnames, private passwords, session JSON, `.env` files, production order data, internal customer mappings, or company-specific artwork are included. The placeholders are intentionally non-functional. When discussing a portfolio interview, the actual production installation remains separate.
