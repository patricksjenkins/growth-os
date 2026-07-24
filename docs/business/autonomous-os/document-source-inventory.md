# Document source inventory

**Inventory date:** 2026-07-24

**Mode:** read-only, aggregate-only, no document contents opened or copied

## Confirmed provider

Supabase Storage is the only document-capable cloud provider currently wired
into the application. The repository and Railway configuration expose no
implemented Google Drive, Box, Dropbox, SharePoint, OneDrive, or Notion
document adapter.

Existing storage conventions are intentionally preserved. The new canonical
Document Center uses a separate private `fga-documents` bucket and the path:

```text
<tenant_uuid>/<document_uuid>/<version_number>/<safe_filename>
```

No existing bucket, path, object, or tenant configuration is migrated or
rewritten by the foundation.

## Aggregate source candidates

| Candidate class | Aggregate count | Initial disposition |
|---|---:|---|
| Corporate/reference material under company, contracts, docs, documentation, and legal locations | 61 | Eligible for manifest review |
| Repository business PDFs | 5 | Eligible for manifest review |
| Receipts, review material, and other sensitive/unclassified candidates | 117 | Excluded pending manual classification |
| Total raw candidates | 183 | No automatic ingestion |

The first ingestion allowlist is therefore capped at 66 candidate files before
deduplication. Counts are aggregate; filenames, customer identities, document
contents, and storage object names are not recorded here.

## Activation requirements

Before any ingestion or signed retrieval is enabled:

1. apply migrations 069 and its forward compatibility migrations in staging;
2. create or verify the private `fga-documents` bucket without changing any
   existing bucket;
3. approve a tenant-bound manifest for the 66 eligible candidates;
4. quarantine and classify the 117 sensitive/unclassified candidates;
5. prove hash-based duplicate handling, malware scanning, MIME validation,
   extraction failure handling, and version/audit atomicity;
6. prove member, manager, owner, explicit-user, and cross-tenant RLS behavior;
7. verify generated agent context contains only authorized chunks and
   version-specific citations;
8. keep upload, ingestion, and retrieval flags disabled until the consolidated
   production approval.

## Credential containment

A local `credentials.json`-named artifact exists within the broader workspace.
Its contents were not opened. It must remain excluded from source control,
build context, logs, prompts, screenshots, Figma, and ingestion manifests; the
secret scanner and container-context checks remain release blockers.
