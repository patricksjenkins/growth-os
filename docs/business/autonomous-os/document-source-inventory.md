# Document source inventory

**Inventory date:** 2026-07-24

**Mode:** read-only, aggregate-only, filenames and contents suppressed from output

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
| Allowlisted sales and marketing collateral | 47 | Hashed into the local source manifest; not ingestion-ready |
| Unsupported types in the allowlisted roots | 6 | Excluded |
| Hidden paths | 2 | Excluded |
| Sensitive/build directory roots | 1 | Excluded without traversal |
| Hash duplicate groups | 0 | No duplicate disposition required |

The scanner found 47 eligible files (9,572,071 bytes) across the two approved
corporate roots. It outputs only aggregate counts and root fingerprints.
Filenames, customer identities, contents, and future storage object names are
not printed. Every candidate remains `not_scanned`, `not_started`, and
`ingestion_ready=false`; a hash manifest is not malware or extraction evidence.

The scanner is implemented in
`core/documents/local-source-manifest.js` and is run with
`npm run documents:manifest`. It never follows symbolic links, never traverses
build, credential, customer, client, finance, legal, private, receipt, or
secret directories, and never dispatches to a provider.

## Activation requirements

Before any ingestion or signed retrieval is enabled:

1. apply migrations 069 and its forward compatibility migrations in staging;
2. create or verify the private `fga-documents` bucket without changing any
   existing bucket;
3. retain the tenant-bound hash manifest for the 47 eligible candidates;
4. keep every excluded or unclassified candidate outside ingestion;
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
