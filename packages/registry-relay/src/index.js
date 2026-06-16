// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

const JSON_CONTENT_TYPES = new Set([
  "application/json",
  "application/problem+json",
  "application/vnd.sdmx.data+json",
]);
const UNSAFE_PATH_PARTS = new Set(["__proto__", "prototype", "constructor"]);

export class RelayCallerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "RelayCallerError";
    this.code = options.code ?? "relay_caller.error";
  }
}

export function getRecord(options = {}) {
  return async (state) => callRelay(state, recordRequest(state, options));
}

export function listRecords(options = {}) {
  return async (state) => callRelay(state, listRequest(state, options));
}

export function getRelationship(options = {}) {
  return async (state) => callRelay(state, relationshipRequest(state, options));
}

export function queryAggregate(options = {}) {
  return async (state) => callRelay(state, aggregateRequest(state, options));
}

export function discoverDatasets(options = {}) {
  return async (state) => callRelay(state, simpleRequest(state, {
    ...options,
    kind: "datasets",
    method: "GET",
    path: "/v1/datasets",
    purposeRequired: false,
  }));
}

export function getEntitySchema(options = {}) {
  return async (state) => callRelay(state, simpleRequest(state, {
    ...options,
    kind: "entity_schema",
    method: "GET",
    path: `/v1/datasets/${pathPart(requiredResolvedString(state, options.dataset, "options.dataset"))}`
      + `/entities/${pathPart(requiredResolvedString(state, options.entity, "options.entity"))}/schema`,
    purposeRequired: false,
  }));
}

export function listEvidenceOfferings(options = {}) {
  return async (state) => callRelay(state, simpleRequest(state, {
    ...options,
    kind: "evidence_offerings",
    method: "GET",
    path: "/metadata/evidence-offerings",
    purposeRequired: false,
  }));
}

export function relayRequest(options = {}) {
  return async (state) => callRelay(state, simpleRequest(state, {
    ...options,
    kind: options.kind ?? "relay_request",
    method: options.method ?? "GET",
    path: requiredResolvedString(state, options.path, "options.path"),
    purposeRequired: options.purposeRequired ?? false,
  }));
}

export async function callRelay(state, request) {
  const fetchImpl = request.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new RelayCallerError("fetch is required to call Registry Relay", {
      code: "fetch.required",
    });
  }

  let response;
  try {
    response = await fetchImpl(request.url, request.init);
  } catch (_error) {
    return finish(state, request, {
      branch: "retryable_infrastructure",
      problem: {
        code: "transport.error",
        status: 0,
        title: "Registry Relay request failed",
        retryable: true,
      },
    });
  }

  const headers = headersObject(response.headers);
  const body = await readResponseBody(response, request);
  const status = Number(response.status) || 0;

  if ((status >= 200 && status < 300) || status === 304) {
    return finish(state, request, successPayload(request, status, headers, body));
  }

  return finish(state, request, problemPayload(request, status, headers, body));
}

export function buildRelayRequest(state, options = {}) {
  return simpleRequest(state, options);
}

export function redactRelayProblem(response) {
  const body = response?.body ?? response?.data ?? response;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  const { detail: _detail, ...safe } = body;
  return safe;
}

function recordRequest(state, options) {
  const dataset = requiredResolvedString(state, options.dataset, "options.dataset");
  const entity = requiredResolvedString(state, options.entity, "options.entity");
  const id = requiredResolvedString(state, options.id ?? valueFromReference(state, options.idFrom), "options.id");
  return simpleRequest(state, {
    ...options,
    kind: "record",
    method: "GET",
    path: `/v1/datasets/${pathPart(dataset)}/entities/${pathPart(entity)}/records/${pathPart(id)}`,
    query: {
      fields: commaList(resolveInputValue(state, options.fields)),
      expand: commaList(resolveInputValue(state, options.expand)),
    },
    purposeRequired: true,
  });
}

function listRequest(state, options) {
  const dataset = requiredResolvedString(state, options.dataset, "options.dataset");
  const entity = requiredResolvedString(state, options.entity, "options.entity");
  const filters = compactObject(resolveInputValue(state, options.filters ?? {}));
  if (!options.allowUnfiltered && Object.keys(filters).length === 0) {
    throw new RelayCallerError("listRecords requires filters or allowUnfiltered: true", {
      code: "filters.required",
    });
  }
  const limit = resolveInputValue(state, options.limit);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RelayCallerError("listRecords requires a positive integer limit", {
      code: "limit.required",
    });
  }
  return simpleRequest(state, {
    ...options,
    kind: "records",
    method: "GET",
    path: `/v1/datasets/${pathPart(dataset)}/entities/${pathPart(entity)}/records`,
    query: {
      limit,
      cursor: resolveInputValue(state, options.cursor),
      fields: commaList(resolveInputValue(state, options.fields)),
      expand: commaList(resolveInputValue(state, options.expand)),
      ...filters,
    },
    purposeRequired: true,
  });
}

function relationshipRequest(state, options) {
  const dataset = requiredResolvedString(state, options.dataset, "options.dataset");
  const entity = requiredResolvedString(state, options.entity, "options.entity");
  const id = requiredResolvedString(state, options.id ?? valueFromReference(state, options.idFrom), "options.id");
  const relationship = requiredResolvedString(state, options.relationship, "options.relationship");
  const limit = resolveInputValue(state, options.limit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new RelayCallerError("getRelationship limit must be a positive integer", {
      code: "limit.invalid",
    });
  }
  return simpleRequest(state, {
    ...options,
    kind: "relationship",
    method: "GET",
    path: `/v1/datasets/${pathPart(dataset)}/entities/${pathPart(entity)}/records/${pathPart(id)}`
      + `/relationships/${pathPart(relationship)}`,
    query: {
      limit,
      cursor: resolveInputValue(state, options.cursor),
    },
    purposeRequired: true,
  });
}

function aggregateRequest(state, options) {
  const dataset = requiredResolvedString(state, options.dataset, "options.dataset");
  const aggregate = requiredResolvedString(state, options.aggregate, "options.aggregate");
  const format = resolveInputValue(state, options.format) ?? "json";
  if (!["json", "csv", "sdmx-json"].includes(format)) {
    throw new RelayCallerError("queryAggregate format must be json, csv, or sdmx-json", {
      code: "format.invalid",
    });
  }
  const body = compactObject(resolveInputValue(state, options.body ?? {
    filters: options.filters,
    format,
    group_by: options.groupBy ?? options.dimensions,
    max_rows: options.maxRows,
    measures: options.measures,
    temporal: options.temporal,
  }));
  return simpleRequest(state, {
    ...options,
    kind: "aggregate",
    method: "POST",
    path: `/v1/datasets/${pathPart(dataset)}/aggregates/${pathPart(aggregate)}/query`,
    query: { f: format },
    body,
    purposeRequired: true,
    responseFormat: format,
  });
}

function simpleRequest(state, options) {
  const configuration = configurationObject(state);
  const data = dataObject(state);
  const baseUrl = trimTrailingSlash(requireString(configuration.relay_base_url, "configuration.relay_base_url"));
  const token = requireString(configuration.relay_token ?? configuration.token, "configuration.token");
  const method = requiredResolvedString(state, options.method ?? "GET", "options.method").toUpperCase();
  const path = normalizedPath(requiredResolvedString(state, options.path, "options.path"));
  const purpose = resolveInputValue(state, options.purpose);
  if (options.purposeRequired !== false) {
    requireString(purpose, "options.purpose");
  }
  const requestId = stringOrUndefined(data.request_id)
    ?? stringOrUndefined(resolveInputValue(state, options.requestId))
    ?? randomUUID();
  const query = compactObject(resolveInputValue(state, options.query ?? {}));
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query)) {
    appendQuery(url, key, value);
  }
  const responseFormat = options.responseFormat ?? "json";
  const accept = resolveInputValue(state, options.accept);

  const headers = compactObject({
    Authorization: `Bearer ${token}`,
    Accept: accept ?? acceptHeader(responseFormat),
    "Content-Type": method === "POST" || method === "PUT" || method === "PATCH" ? "application/json" : undefined,
    "Data-Purpose": purpose,
    "If-None-Match": resolveInputValue(state, options.ifNoneMatch),
    "X-Request-Id": requestId,
    traceparent: stringOrUndefined(data.traceparent),
  });
  const body = resolveInputValue(state, options.body);

  return {
    kind: options.kind ?? "relay_request",
    as: stringOrUndefined(options.as) ?? defaultResultName(options.kind),
    url: url.toString(),
    init: {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    fetch: options.fetch,
    responseFormat,
    purpose,
    requestId,
    redactDataPaths: redactDataPaths(options),
  };
}

function successPayload(request, status, headers, body) {
  const base = {
    branch: status === 304 ? "not_modified" : "succeeded",
    request_id: responseHeader(headers, "x-request-id") ?? request.requestId,
    purpose: request.purpose,
    etag: responseHeader(headers, "etag"),
  };
  if (status === 304) {
    return base;
  }
  switch (request.kind) {
    case "record":
      return { ...base, record: body };
    case "records":
    case "relationship":
      return {
        ...base,
        records: Array.isArray(body?.data) ? body.data : body,
        pagination: body?.pagination,
      };
    case "aggregate":
      return {
        ...base,
        aggregate: body,
        observations: Array.isArray(body?.observations) ? body.observations : undefined,
        completeness: body?.completeness,
        disclosure_control: body?.disclosure_control,
      };
    case "datasets":
      return {
        ...base,
        datasets: Array.isArray(body?.data) ? body.data : body,
      };
    case "evidence_offerings":
      return {
        ...base,
        offerings: Array.isArray(body?.evidence_offerings) ? body.evidence_offerings : body,
      };
    case "entity_schema":
      return { ...base, schema: body };
    default:
      return { ...base, body };
  }
}

function problemPayload(request, status, headers, body) {
  const code = stringOrUndefined(body?.code) ?? statusToFallbackCode(status);
  const branch = problemBranch(code, status);
  const retryAfter = retryAfterSeconds(headers);
  return {
    branch,
    request_id: responseHeader(headers, "x-request-id") ?? stringOrUndefined(body?.request_id) ?? request.requestId,
    purpose: request.purpose,
    ...(retryAfter !== undefined ? { retry_after_seconds: retryAfter } : {}),
    problem: {
      code,
      status,
      title: stringOrUndefined(body?.title),
      retryable: branch === "retryable_infrastructure",
    },
  };
}

function finish(state, request, result) {
  const data = { ...dataObject(state) };
  delete data.relay_request;
  delete data.relay_context;
  for (const path of request.redactDataPaths) {
    deleteDataPath(data, path);
  }
  const { configuration: _configuration, response: _response, ...safeState } = state;
  return {
    ...safeState,
    data: {
      ...data,
      [request.as]: compactObject(result),
    },
  };
}

async function readResponseBody(response, request) {
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  if (request.responseFormat === "csv") {
    return text;
  }
  const contentType = responseHeader(headersObject(response.headers), "content-type")?.split(";")[0]?.trim();
  if (contentType && !JSON_CONTENT_TYPES.has(contentType) && !contentType.endsWith("+json")) {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new RelayCallerError("Registry Relay response was not valid JSON", {
      code: "response.invalid_json",
    });
  }
}

function problemBranch(code, status) {
  if (status === 404) {
    return "not_found";
  }
  if (status === 401 || code?.startsWith("auth.")) {
    return "auth_failed";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (code === "entity.filter_required") {
    return "filter_required";
  }
  if (code?.includes("cursor")) {
    return "cursor_invalid";
  }
  if (status === 429 || status === 503 || status >= 500) {
    return "retryable_infrastructure";
  }
  return "failed";
}

function statusToFallbackCode(status) {
  if (status === 401) {
    return "auth.failed";
  }
  if (status === 403) {
    return "auth.forbidden";
  }
  if (status === 404) {
    return "resource.not_found";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status >= 500) {
    return "source.unavailable";
  }
  return "request.failed";
}

function retryAfterSeconds(headers) {
  const raw = responseHeader(headers, "retry-after");
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (Number.isSafeInteger(parsed) && parsed > 0) {
    return parsed;
  }
  const retryAt = Date.parse(raw);
  if (!Number.isFinite(retryAt)) {
    return undefined;
  }
  const serverDate = Date.parse(responseHeader(headers, "date") ?? "");
  const referenceTime = Number.isFinite(serverDate) ? serverDate : Date.now();
  const seconds = Math.ceil((retryAt - referenceTime) / 1000);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

function acceptHeader(format) {
  if (format === "csv") {
    return "text/csv";
  }
  if (format === "sdmx-json") {
    return "application/vnd.sdmx.data+json;version=2.1, application/json";
  }
  return "application/json";
}

function appendQuery(url, key, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  if (Array.isArray(value)) {
    url.searchParams.set(key, value.map((item) => String(item)).join(","));
    return;
  }
  if (typeof value === "object") {
    throw new RelayCallerError(`query parameter ${key} must be scalar or array`, {
      code: "query.invalid",
    });
  }
  url.searchParams.set(key, String(value));
}

function commaList(value) {
  if (Array.isArray(value)) {
    return value.join(",");
  }
  return value;
}

function compactObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const compacted = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && item !== null && item !== "") {
      compacted[key] = item;
    }
  }
  return compacted;
}

function resolveInputValue(state, value) {
  if (typeof value === "function") {
    return value(state);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveInputValue(state, item));
  }
  if (value && typeof value === "object") {
    if (typeof value.valueFrom === "string") {
      return valueFromPath(dataObject(state), value.valueFrom);
    }
    const resolved = {};
    for (const [key, item] of Object.entries(value)) {
      resolved[key] = resolveInputValue(state, item);
    }
    return resolved;
  }
  return value;
}

function valueFromReference(state, path) {
  return typeof path === "string" ? valueFromPath(dataObject(state), path) : undefined;
}

function valueFromPath(data, path) {
  const parts = safePathParts(path);
  if (!parts || parts.length === 0) {
    return undefined;
  }
  let current = data;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, part)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function redactDataPaths(options) {
  const paths = new Set(Array.isArray(options.redactDataPaths) ? options.redactDataPaths : []);
  collectValueFromPaths(options, paths);
  return [...paths].filter((path) => typeof path === "string" && path.length > 0);
}

function collectValueFromPaths(value, paths) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectValueFromPaths(item, paths);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (typeof value.valueFrom === "string") {
    paths.add(value.valueFrom);
  }
  if (typeof value.idFrom === "string") {
    paths.add(value.idFrom);
  }
  for (const item of Object.values(value)) {
    collectValueFromPaths(item, paths);
  }
}

function deleteDataPath(data, path) {
  const parts = safePathParts(path);
  if (!parts || parts.length === 0) {
    return;
  }
  if (parts.length === 1) {
    delete data[parts[0]];
    return;
  }
  let current = data;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, part)) {
      return;
    }
    const next = current[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      return;
    }
    current[part] = { ...next };
    current = current[part];
  }
  delete current[parts[parts.length - 1]];
}

function safePathParts(path) {
  if (typeof path !== "string" || path.length === 0) {
    return undefined;
  }
  const parts = path.split(".").filter((part) => part.length > 0);
  if (parts.some((part) => UNSAFE_PATH_PARTS.has(part))) {
    return undefined;
  }
  return parts;
}

function dataObject(state) {
  return state?.data && typeof state.data === "object" && !Array.isArray(state.data) ? state.data : {};
}

function configurationObject(state) {
  return state?.configuration && typeof state.configuration === "object" && !Array.isArray(state.configuration)
    ? state.configuration
    : {};
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new RelayCallerError(`${label} is required`, { code: "value.required" });
  }
  return value;
}

function requiredResolvedString(state, value, label) {
  return requireString(String(resolveInputValue(state, value) ?? ""), label);
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function pathPart(value) {
  return encodeURIComponent(value);
}

function normalizedPath(path) {
  if (/^https?:\/\//i.test(path)) {
    throw new RelayCallerError("options.path must be relative", { code: "path.absolute" });
  }
  return path.startsWith("/") ? path : `/${path}`;
}

function headersObject(headers) {
  if (!headers) {
    return {};
  }
  if (typeof headers.forEach === "function") {
    const result = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  return { ...headers };
}

function responseHeader(headers, name) {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  const exact = headers[name];
  if (typeof exact === "string") {
    return exact;
  }
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName && typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function defaultResultName(kind) {
  if (typeof kind === "string" && kind.length > 0) {
    return kind;
  }
  return "relay";
}
