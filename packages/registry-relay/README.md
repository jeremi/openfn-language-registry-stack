# OpenFn Registry Relay Adaptor

OpenFn helpers for reading protected Registry Relay APIs from workflows.

Use this package when a workflow is authorized to read registry rows, metadata,
relationships, or aggregate outputs directly. Use
`@openfn/language-registry-notary` when the workflow needs a trust decision or a
certified value claim.

When this repository is used as `OPENFN_ADAPTORS_REPO`, this package is loaded
as:

```text
@openfn/language-registry-relay@local
```

## Configure

Create an OpenFn credential with:

- `relay_base_url`: Registry Relay service base URL.
- `token`: bearer token or API key for the Relay caller credential.

The adaptor sends credentials as `Authorization: Bearer <token>`. It does not
send `x-api-key`.

The examples below use the public Registry Stack lab at
`https://lab.registrystack.org`. The lab publishes current credential metadata
at `https://lab.registrystack.org/api/lab.json`; use `agri-row-reader` for row
reads, `agri-aggregate-reader` for aggregate reads, `agri-metadata` for dataset
discovery, and `agri-evidence-only` for evidence offering discovery.

## Read One Record

```js
execute(
  getRecord({
    dataset: "agri_registry",
    entity: "farmer",
    id: dataValue("farmer_id"),
    purpose: "https://demo.example.gov/purpose/nagdi/climate-smart-input-support",
    fields: ["id", "district", "registration_status"],
    as: "farmer",
    redactDataPaths: ["farmer_id"],
  }),

  fn((state) => {
    const farmer = state.data.farmer.record;

    return {
      ...state,
      data: {
        ...state.data,
        decision_input: {
          farmer_id: farmer.id,
          district: farmer.district,
          relay_request_id: state.data.farmer.request_id,
        },
      },
    };
  }),
);
```

## List Records

Collection reads require an explicit `limit` and at least one filter unless
`allowUnfiltered: true` is set.

```js
execute(
  listRecords({
    dataset: "agri_registry",
    entity: "farmer",
    purpose: "https://demo.example.gov/purpose/nagdi/climate-smart-input-support",
    filters: {
      district: "north",
      "id.in": ["FARMER-1001", "FARMER-1002"],
    },
    fields: ["id", "district", "registration_status"],
    limit: 50,
    as: "farmers",
  }),
);
```

## Query An Aggregate

```js
execute(
  queryAggregate({
    dataset: "agri_registry",
    aggregate: "voucher_opportunities_by_district_crop_risk_input",
    purpose: "https://demo.example.gov/purpose/nagdi/program-monitoring",
    dimensions: ["district_code"],
    measures: ["eligible_opportunity_count"],
    filters: { season: ["2026A"] },
    maxRows: 100,
    as: "district_summary",
  }),

  fn((state) => {
    const observations = state.data.district_summary.observations;

    return {
      ...state,
      data: {
        ...state.data,
        north_voucher_opportunities:
          observations.find((row) => row.district_code === "north")?.eligible_opportunity_count ?? 0,
      },
    };
  }),
);
```

## Discovery

```js
execute(
  discoverDatasets({ as: "catalog" }),
  getEntitySchema({
    dataset: "agri_registry",
    entity: "farmer",
    as: "farmer_schema",
  }),
  listEvidenceOfferings({ as: "evidence_offerings" }),
);
```

## Result Branches

Every helper writes its result under `state.data[as]`. If `as` is omitted, the
default names are `record`, `records`, `relationship`, `aggregate`, `datasets`,
`entity_schema`, or `evidence_offerings`.

Common branches:

- `succeeded`
- `not_modified`
- `not_found`
- `auth_failed`
- `forbidden`
- `filter_required`
- `cursor_invalid`
- `retryable_infrastructure`
- `failed`

Problem Details are reduced to safe fields: `code`, `status`, `title`, and
`retryable`. The adaptor does not expose Problem Details `detail`.

## Guardrails

- Row, relationship, and aggregate helpers require `purpose`.
- `listRecords` requires `limit` and filters unless `allowUnfiltered: true`.
- Query values support OpenFn references such as `dataValue("farmer_id")`, plus
  `{ valueFrom: "farmer_id" }` for simple path-based lookup.
- `X-Request-Id` uses `state.data.request_id` when present.
- `traceparent` is forwarded when `state.data.traceparent` is present.
- `ETag`, `Retry-After`, request id, and pagination cursors are preserved.
- Credentials, raw request material, and `configuration` are removed from final
  state.

Relay is a protected consultation API. It can publish evidence offerings, but it
does not evaluate trust decisions. Use the Registry Notary adaptor for claim
evaluation and certified value claims.
