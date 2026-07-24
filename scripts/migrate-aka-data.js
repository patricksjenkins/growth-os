/**
 * RETIRED — A Kut Above legacy data migration.
 *
 * The one-time migration completed before the Autonomous Company OS work.
 * The former implementation embedded a service-role credential and is
 * intentionally disabled. Do not reconstruct or rerun it against an active
 * client from repository history.
 *
 * If a new migration is required, create a reviewed, idempotent replacement
 * that reads both source and destination credentials from the environment,
 * supports a read-only plan, records an applied-migration ledger, and requires
 * an explicit production approval.
 */

'use strict';

throw new Error(
  'This legacy production-data migration is retired. Create a new reviewed migration plan instead.'
);
