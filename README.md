# OpenFn Language Registry Stack

Local OpenFn adaptor monorepo for Registry Stack services.

This repository is shaped for OpenFn local adaptor loading:

```sh
export LOCAL_ADAPTORS=true
export OPENFN_ADAPTORS_REPO=/path/to/openfn-language-registry-stack
```

With OpenFn kit support from
[OpenFn/kit#1397](https://github.com/OpenFn/kit/pull/1397), this repository can
also be listed before the canonical OpenFn adaptors repo:

```sh
export OPENFN_ADAPTORS_REPO=/path/to/openfn-language-registry-stack,/path/to/adaptors
```

Lightning and the worker resolve `packages/registry-stack` as:

```text
@openfn/language-registry-stack@local
```

## Packages

- [packages/registry-stack](packages/registry-stack): Registry Notary client
  helper for OpenFn workflows.

## Verify

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```
