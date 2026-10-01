// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { types as utilTypes } from "node:util";
export * from "@openfn/language-common";

const require = createRequire(import.meta.url);
const { RelayClient, RelayClientError } = require("./native.cjs");
const UNSAFE_PATH_PARTS = new Set(["__proto__", "prototype", "constructor"]);

class OperationFailure extends Error {
  constructor(code) {
    super("Registry Relay operation input is invalid");
    this.code = code;
  }
}

/** Read the governed service description and its published capability inventory. */
export function getServiceMetadata(options = {}) {
  return operation(options, (client, input) => client.serviceMetadata(input.etag));
}

/** Fetch one bounded page of governed resources. */
export function listResources(options = {}) {
  return operation(options, (client, input) => client.resources(
    pick(input, ["pageSize"]), input.etag,
  ));
}

/** Continue a resource page with the opaque continuation returned by listResources. */
export function continueResources(options = {}) {
  return operation(options, (client, input) => client.continueResources(
    requiredObject(input.continuation), input.etag,
  ));
}

/** Read one governed resource description. */
export function getResource(options = {}) {
  return operation(options, (client, input) => client.resource(
    requiredString(input.resource), input.etag,
  ));
}

/** Read one Registry Record through a compiled Relay resource. */
export function getRecord(options = {}) {
  return operation(options, (client, input) => client.readRecord(
    requiredString(input.resource), requiredString(input.recordIdentifier),
    recordOptions(input), input.etag,
  ));
}

/** Fetch one bounded record page. Continue it explicitly with continueList. */
export function listRecords(options = {}) {
  return operation(options, (client, input) => client.listRecords(
    requiredString(input.resource),
    pick(input, ["pageSize", "fields", "accessProfile", "format", "filters"]),
    input.etag,
  ));
}

/** Continue a record page with the opaque continuation returned by listRecords. */
export function continueList(options = {}) {
  return operation(options, (client, input) => client.continueListRecords(
    requiredObject(input.continuation), input.etag,
  ));
}

/** Resolve one record through a named, compiled lookup. */
export function lookupRecord(options = {}) {
  return operation(options, (client, input) => client.lookup(
    requiredString(input.resource), requiredString(input.lookup),
    requiredObject(input.selectors), recordOptions(input), input.etag,
  ));
}

/** Read governed aggregate data through Relay's SDMX 2.1 data surface. */
export function queryAggregate(options = {}) {
  return operation(options, async (client, input) => rawDocument(
    await client.sdmxData(
      pick(input, [
        "agency", "resource", "version", "key", "constraints", "offset", "limit",
        "dimensionAtObservation", "format",
      ]),
      input.etag,
    ),
  ));
}

function operation(options, invoke) {
  return async (state) => {
    let input = {};
    const referencedDataPaths = new Set();
    let result;
    try {
      const supplied = typeof options === "function" ? options(state) : options;
      if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
        throw new OperationFailure("request.invalid");
      }
      input = resolveInputValue(state, supplied, referencedDataPaths);
      const client = new RelayClient(relayConfiguration(copyPlainValue(
        state?.configuration, "configuration.invalid",
      )));
      result = successResult(await invoke(client, input));
    } catch (error) {
      result = failureResult(error);
    }

    const as = typeof input.as === "string" && input.as.length > 0 ? input.as : "relay";
    const data = redactedData(state, input, referencedDataPaths);
    const { response: _response, ...safeState } = state;
    // OpenFn removes credentials at the job boundary. Keeping configuration here
    // preserves execute/each composition across several Relay operations.
    return { ...safeState, data: { ...data, [as]: result } };
  };
}

function successResult(outcome) {
  if (outcome?.kind === "notModified") {
    return pick({ branch: "not_modified", ...outcome }, ["branch", "etag", "traceId"]);
  }
  if (outcome?.kind !== "complete") {
    return { branch: "protocol_failed", problem: { code: "relay.outcome", retryable: false } };
  }
  return {
    branch: "succeeded",
    ...pick(outcome, ["value", "etag", "continuation", "traceId", "body", "mediaType"]),
  };
}

function rawDocument(outcome) {
  if (outcome?.kind !== "complete") return outcome;
  return {
    ...outcome,
    body: Buffer.isBuffer(outcome.body) ? outcome.body.toString("utf8") : outcome.body,
  };
}

function failureResult(error) {
  if (error instanceof OperationFailure) {
    return { branch: "invalid_request", problem: { code: error.code, retryable: false } };
  }
  if (!(error instanceof RelayClientError)) {
    return { branch: "failed", problem: { code: "relay.operation", retryable: false } };
  }

  const status = Number.isSafeInteger(error.status) ? error.status : 0;
  let branch = "failed";
  if (error.kind === "configuration" || error.kind === "invalid_request") branch = "invalid_request";
  else if (error.kind === "problem" && status === 400) branch = "invalid_request";
  else if (error.kind === "transport" || (error.kind === "token" && error.tokenKind === "transport")
    || (error.kind === "problem" && (status === 429 || status >= 500))) branch = "retryable_infrastructure";
  else if (error.kind === "token" || status === 401) branch = "auth_failed";
  else if (status === 403) branch = "denied";
  else if (status === 404 || error.kind === "not_found") branch = "not_found";
  else if (status === 409 || status === 412) branch = "conflict";
  else if (error.kind === "protocol") branch = "protocol_failed";

  const code = safeString(error.code);
  return {
    branch,
    problem: {
      code: code?.includes(".") ? code : `relay.${error.kind}`,
      status,
      retryable: branch === "retryable_infrastructure",
    },
    ...pick(error, ["traceId", "retryAfterSeconds", "transportKind", "tokenKind"]),
  };
}

function relayConfiguration(configuration) {
  const source = configuration?.relay ?? configuration;
  if (source?.baseUrl !== undefined || source?.authorization !== undefined) return source;
  return {
    baseUrl: requiredString(source?.relay_base_url),
    authorization: { static: requiredString(source?.token ?? source?.relay_token) },
  };
}

function recordOptions(input) {
  return pick(input, ["fields", "accessProfile", "format"]);
}

function requiredString(value) {
  if (typeof value !== "string" || value.length === 0) throw new OperationFailure("request.required");
  return value;
}

function requiredObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OperationFailure("request.required");
  }
  return value;
}

function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
}

function resolveInputValue(state, value, referencedDataPaths) {
  return copyPlainValue(value, "request.invalid", {
    state, resolveFunctions: true, resolveReferences: true, referencedDataPaths,
  });
}

function copyPlainValue(value, code, options = {}) {
  const active = new Set();
  let nodes = 0;
  let bytes = 0;
  const invalid = () => { throw new OperationFailure(code); };
  const charge = (text) => {
    bytes += Buffer.byteLength(text);
    if (bytes > 4 * 1024 * 1024) invalid();
    return text;
  };

  function visit(item, depth) {
    if (++nodes > 100000 || depth > 128) invalid();
    if (typeof item === "function") {
      if (!options.resolveFunctions) invalid();
      return visit(item(options.state), depth + 1);
    }
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") return charge(item);
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || utilTypes.isProxy(item) || active.has(item)) invalid();

    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array) {
      if (!prototype || Object.getOwnPropertyDescriptor(prototype, "constructor")?.value?.name !== "Array"
        || Object.getPrototypeOf(Object.getPrototypeOf(prototype)) !== null) invalid();
    } else if (prototype !== null && (Object.getPrototypeOf(prototype) !== null
      || Object.getOwnPropertyDescriptor(prototype, "constructor")?.value?.name !== "Object")) invalid();

    const keys = Reflect.ownKeys(item);
    if (keys.some((key) => typeof key !== "string")) invalid();
    const descriptors = new Map();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
      descriptors.set(key, descriptor);
    }
    if (options.resolveReferences && !array && descriptors.has("valueFrom")) {
      const reference = descriptors.get("valueFrom").value;
      if (typeof reference !== "string") invalid();
      options.referencedDataPaths?.add(reference);
      return visit(valueFromPath(options.state?.data, reference), depth + 1);
    }

    active.add(item);
    const result = array ? [] : {};
    let count = 0;
    for (const key of keys) {
      const descriptor = descriptors.get(key);
      if (array && key === "length") continue;
      if (!descriptor.enumerable) invalid();
      charge(key);
      if (array && (!Number.isSafeInteger(Number(key)) || Number(key) < 0
        || String(Number(key)) !== key || Number(key) >= item.length)) invalid();
      Object.defineProperty(result, key, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      count += 1;
    }
    if (array && count !== item.length) invalid();
    active.delete(item);
    return result;
  }

  return visit(value, 0);
}

function redactedData(state, input, referencedDataPaths) {
  const data = { ...(state?.data && typeof state.data === "object" ? state.data : {}) };
  const paths = new Set(Array.isArray(input.redactDataPaths) ? input.redactDataPaths : []);
  for (const path of referencedDataPaths) paths.add(path);
  for (const path of paths) deleteDataPath(data, path);
  return data;
}

function valueFromPath(data, path) {
  const parts = safePathParts(path);
  let current = data;
  for (const part of parts ?? []) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, part);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
    current = descriptor.value;
  }
  return current;
}

function deleteDataPath(data, path) {
  const parts = safePathParts(path);
  if (!parts?.length) return;
  let current = data;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const next = current?.[parts[index]];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    current[parts[index]] = { ...next };
    current = current[parts[index]];
  }
  delete current[parts.at(-1)];
}

function safePathParts(path) {
  if (typeof path !== "string" || path.length === 0) return undefined;
  const parts = path.split(".").filter(Boolean);
  return parts.some((part) => UNSAFE_PATH_PARTS.has(part)) ? undefined : parts;
}

function safeString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
