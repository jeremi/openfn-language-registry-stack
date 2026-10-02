# Changelog

## Unreleased

### Added

- The event bridge accepts `BREG_BIND_HOST=127.0.0.1` for host-local receivers.
  Its existing `0.0.0.0` default remains unchanged.
- `@openfn/language-registry-casework` wraps the native Casework client for
  requester review requests and results, source inboxes and task grants.
- `@openfn/language-registry-relay` provides governed V2 record reads, lookups,
  pagination, metadata and SDMX aggregate queries through the native client.

### Changed

- The Evidence, BREG, Casework and Relay V2 adaptors pin the published
  `@registrystack/client` 0.38.0. Relay uses governed V2 resources and native
  continuations; Casework uses current review-request bindings and results.
- The container pilot uses matching Registry Stack 0.38 clients, tools and
  packages, ThunderID identity, Casework correction review, and explicit BREG
  application. Evidence uses persistent OpenBao Transit signing and local TLS
  origins. Its new configuration and volumes are separate from the retained
  0.27 data.
- The event bridge's explicit `hook-envelope-v1` mode validates canonical
  0.38 events and returns the native notification acknowledgement after
  durable OpenFn acceptance. The legacy body mode remains available.

### Removed

- Removed the Relay v1 adaptor (`@openfn/language-registry-relay`), its
  credential schema, example job, tests and workspace dependencies. Workflows
  using that local adaptor must be updated before upgrading. The replacement
  native Relay V2 adaptor uses different configuration, options and result shapes.

## 0.1.0 Beta

First self-hosted Evidence and BREG agricultural-holdings pilot.

- Separate OpenFn adaptors use the maintained Registry Stack 0.27.0 client.
- Registration uses explicit idempotency. Corrections follow governed change
  requests with separate reviewer approval and manual application.
- Committed events pass through an authenticated bridge, request verified signed
  registration evidence, and produce atomic, deduplicated destination updates.
- Pinned upstream Lightning and worker packaging, Compose setup, repeatable
  workflow provisioning, and operator recovery commands are included.
- Linux acceptance covers fresh installation, the complete workflow journey,
  restart recovery, failed delivery, failed workflow steps and queued work.

### Release scope

This is a source release for supervised synthetic pilots. Setup builds the
containers locally from the committed dependency locks and pinned images.
The worker requires Linux amd64; native adaptor imports also support Linux
arm64. The assertion confirms registration only, without disclosing the holding
name or establishing ownership or programme eligibility.

Relay, legacy Notary, hosted OpenFn, wallet issuance, npm publication and OpenFn
catalogue acceptance are outside this beta. Root dependency overrides apply to
the locked source deployment and do not accompany independently installed npm
packages.

Stop/start preserves data; reset is a separate explicit destructive operation.
See the [operator guide](README.md) for private inputs, retention and recovery.
