# Document ingestion and permissioned retrieval

Migration 080 adds an evidence-only ingestion boundary and a citation-bound
retrieval boundary to the canonical Document Center introduced by migration
069. Both boundaries are inactive by default. The implementation does not
upload or download an object, contact a provider, or make a production change.

## Current provider truth

Supabase Storage bucket `fga-documents` is the canonical provider contract.
There is no configured Google Drive or Box adapter. No provider connection row
is seeded by migration 080, and `provider_dispatch_enabled` is constrained to
`false`.

Object paths retain the migration 069 contract:

`<tenant_uuid>/<document_uuid>/<version_number>/<safe_filename>`

The ingestion RPC calculates this path itself. A caller cannot supply a bucket
or path, and a digest lookup is always constrained to the requested tenant.

## Ingestion boundary

`document_ingestion_register_rpc` can only be executed by `service_role`. A
command also requires all of the following:

- the caller-provided feature gate is exactly `true`;
- an exact-tenant `document_ingestion_controls` row exists;
- that row is enabled in `shadow` mode with its kill switch cleared;
- the provider is `supabase_storage`;
- provider dispatch remains structurally disabled;
- the target document exists in the same tenant;
- filename, MIME type, byte size, SHA-256 digest, actor, idempotency key, and
  evidence are valid.

An accepted command creates only a pending `document_versions` metadata row,
an immutable receipt, and an immutable document event. It does not assert that
an object exists. It does not advance `documents.current_version_number`, so
pending or unverified content cannot become retrievable.

Duplicate detection uses SHA-256 within one tenant. The same digest in another
tenant is deliberately invisible. A duplicate creates evidence but no new
version. Exact retries replay the receipt; a changed request under the same
idempotency key fails.

## Retrieval boundary

`document_retrieval_search_rpc` is read-only and can only be executed by
`service_role` with an explicit feature gate. Every result must satisfy:

- exact tenant identity;
- a verified user membership and matching role, or an explicit unexpired agent
  grant for that document;
- the document's current version;
- `ready` ingestion, `clean` malware scan, and `ready` text extraction;
- a full-text match.

Results omit storage paths and provider identifiers. Each excerpt carries a
version-specific chunk citation. Document version content, chunk citations,
document events, and ingestion receipts are protected from update or delete.

## Activation gate

Do not enable this in production until the consolidated approval packet covers:

1. the exact tenant cohort;
2. a verified private Supabase bucket and tenant path probe;
3. malware and extraction workers that produce authoritative status evidence;
4. a version-promotion command that advances the current version only after
   verification;
5. negative retrieval tests for users and every agent identity;
6. migration apply/replay/rollback evidence;
7. rollback and kill-switch ownership.

The pure planner in `core/documents/ingestion.js` is safe for local and shadow
validation. Its provider contract reports `configured: false`, exposes no
operations, and refuses provider dispatch.

## Verification

Run the focused local suite:

```sh
node --test test/document-ingestion.test.js test/document-control.test.js test/document-routes.test.js
```

In the real PostgreSQL migration harness, apply migration 080 after 079 and run
`test/sql/document-ingestion-retrieval-negative.sql` after the shared synthetic
tenant fixtures. The proof covers service-role boundaries, disabled flags,
cross-tenant ingestion, tenant-scoped duplicate detection, exact replay,
agent grants, citation output, and immutable evidence.

Rollback 080 removes the callable ingestion and retrieval boundaries, engages
every configured kill switch, and preserves all evidence and version data.
