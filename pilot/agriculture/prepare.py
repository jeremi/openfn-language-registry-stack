#!/usr/bin/env python3
"""Prepare a fresh, offline Registry Stack 0.38 agriculture pilot."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile

import yaml

from issuer import prepare_issuer


HERE = Path(__file__).resolve().parent
VERSION = "0.38.0"
RESOURCE = "urn:example:audience:agriculture-pilot"
PROFILE = "breg-8-registry-4-farm-19-by-local-identifier"
REQUIREMENT = "urn:example:requirement:holding-registered:v1"


def write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists():
        raise RuntimeError(f"prepared output already exists: {path}")
    if isinstance(value, str):
        body = value
    elif path.suffix in {".yaml", ".yml"}:
        body = yaml.safe_dump(value, sort_keys=False)
    else:
        body = json.dumps(value, indent=2, sort_keys=True) + "\n"
    path.write_text(body, encoding="utf-8")
    path.chmod(0o600)


def run(binary: Path | str, *args: object) -> str:
    result = subprocess.run(
        [str(binary), *map(str, args)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode:
        raise RuntimeError(
            f"{Path(binary).name} command failed (exit {result.returncode}); "
            "raw output was withheld"
        )
    return result.stdout


def check_versions(bins: Path) -> None:
    for name in ("bregctl", "caseworkctl", "evidencectl", "evidence"):
        reported = run(bins / name, "--version").split()[-1]
        if reported not in {VERSION, VERSION + "-dev"}:
            raise SystemExit(
                f"{name} reports {reported}; this pilot requires Registry Stack {VERSION}"
            )


def secure_prepared_tree(root: Path) -> None:
    for path in root.rglob("*"):
        path.chmod(0o700 if path.is_dir() else 0o600)


def client_descriptors(root: Path) -> list[dict]:
    def client(
        logical_id: str,
        scopes: list[str],
        claims: dict[str, object],
        *,
        human: bool = False,
    ) -> dict:
        value = {
            "logicalId": logical_id,
            "clientId": logical_id,
            "subject": f"synthetic-{logical_id}",
            "resource": RESOURCE,
            "scopes": scopes,
            "claims": claims,
            "keyDirectory": str(root / "clients" / logical_id),
        }
        if human:
            value["allowHumanFixture"] = True
        return value

    return [
        client("reader", ["starter:reader"], {
            "registry_actor_kind": "service",
            "registry_principal": "synthetic-reader",
            "registry_purpose": "starter-learning",
        }),
        client("editor", ["starter:editor"], {
            "registry_actor_kind": "human",
            "registry_principal": "synthetic-editor",
            "registry_purpose": "starter-learning",
        }, human=True),
        client("reviewer", ["casework:staff", "starter:reviewer"], {
            "registry_actor_kind": "human",
            "registry_principal": "synthetic-reviewer",
            "registry_purpose": "starter-learning",
        }, human=True),
        client("openfn-service", ["pilot:submit"], {
            "registry_actor_kind": "human",
            "registry_principal": "synthetic-openfn-service",
            "registry_purpose": "agriculture-registration",
        }, human=True),
        client("evidence-source", ["pilot:evidence-source"], {
            "registry_actor_kind": "service",
            "registry_principal": "synthetic-evidence-source",
            "registry_purpose": "evidence-source-read",
        }),
        client("casework-reader", ["casework:source-reader"], {
            "registry_actor_kind": "service",
            "registry_principal": "casework-reader",
            "registry_purpose": "casework-sync",
        }),
        client("casework-producer", ["casework:reviews:request"], {
            "registry_actor_kind": "service",
        }),
        client("casework-admin", ["casework:admin"], {
            "registry_actor_kind": "human",
            "registry_principal": "synthetic-casework-admin",
        }, human=True),
        client("openfn-evidence", ["evidence:request"], {
            "registry_actor_kind": "service",
            "evidence_tags": ["holding-verifier"],
            "evidence_audience": "urn:example:audience:openfn-pilot",
        }),
    ]


def database_files(
    root: Path,
    service: str,
    database: str,
    roles: tuple[str, str],
) -> None:
    database_root = root / f"{service}-db"
    secrets_root = root / service / "secrets"
    admin_password = secrets.token_hex(24)
    migration_password = secrets.token_hex(24)
    runtime_password = secrets.token_hex(24)
    migration_role, runtime_role = roles
    write(
        database_root / "postgres.env",
        f"POSTGRES_USER=postgres\nPOSTGRES_PASSWORD={admin_password}\nPOSTGRES_DB=postgres\n",
    )
    sql = (
        f"CREATE ROLE {migration_role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
        f"NOINHERIT NOBYPASSRLS PASSWORD '{migration_password}';\n"
        f"CREATE ROLE {runtime_role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
        f"NOINHERIT NOBYPASSRLS PASSWORD '{runtime_password}';\n"
    )
    databases = [database, database + "_test"] if service == "breg" else [database]
    for name in databases:
        owner = "" if service == "breg" else f" OWNER {migration_role}"
        sql += (
            f"CREATE DATABASE {name}{owner};\n"
            f"\\connect {name}\n"
            "CREATE EXTENSION IF NOT EXISTS btree_gist;\n"
            f"REVOKE ALL ON DATABASE {name} FROM PUBLIC;\n"
            f"GRANT CONNECT ON DATABASE {name} TO {migration_role}, {runtime_role};\n"
        )
        if service == "breg":
            schemas = (
                "registry_internal", "registry_data", "registry_source",
                "registry_derived", "registry_context",
            )
            sql += "".join(
                f"CREATE SCHEMA {schema} AUTHORIZATION {migration_role};\n"
                for schema in schemas
            )
            sql += (
                "REVOKE ALL ON SCHEMA " + ", ".join(schemas)
                + " FROM PUBLIC;\n"
            )
    write(database_root / "bootstrap.sql", sql)
    host = f"{service}-db"
    write(
        secrets_root / "runtime-database-url",
        f"postgresql://{runtime_role}:{runtime_password}@{host}:5432/{database}",
    )
    write(
        secrets_root / "migration-database-url",
        f"postgresql://{migration_role}:{migration_password}@{host}:5432/{database}",
    )
    if service == "breg":
        write(
            secrets_root / "test-runtime-database-url",
            f"postgresql://{runtime_role}:{runtime_password}@{host}:5432/{database}_test",
        )
        write(
            secrets_root / "test-migration-database-url",
            f"postgresql://{migration_role}:{migration_password}@{host}:5432/{database}_test",
        )

    run(
        "openssl", "req", "-x509", "-new", "-nodes", "-newkey", "rsa:2048",
        "-sha256", "-days", "365", "-subj", f"/CN=Synthetic {service} database CA",
        "-addext", "basicConstraints=critical,CA:TRUE",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign",
        "-addext", "subjectKeyIdentifier=hash",
        "-keyout", database_root / "ca.key", "-out", database_root / "ca.pem",
    )
    run(
        "openssl", "req", "-new", "-nodes", "-newkey", "rsa:2048",
        "-subj", f"/CN={host}", "-keyout", database_root / "server.key",
        "-out", database_root / "server.csr",
    )
    write(
        database_root / "server.ext",
        "basicConstraints=critical,CA:FALSE\n"
        "keyUsage=critical,digitalSignature,keyEncipherment\n"
        "extendedKeyUsage=serverAuth\n"
        f"subjectAltName=DNS:{host}\n"
        "subjectKeyIdentifier=hash\n"
        "authorityKeyIdentifier=keyid,issuer\n",
    )
    run(
        "openssl", "x509", "-req", "-sha256", "-days", "365",
        "-in", database_root / "server.csr", "-CA", database_root / "ca.pem",
        "-CAkey", database_root / "ca.key", "-CAcreateserial",
        "-extfile", database_root / "server.ext", "-out", database_root / "server.crt",
    )
    shutil.copyfile(database_root / "ca.pem", secrets_root / "database-ca.pem")
    (secrets_root / "database-ca.pem").chmod(0o600)


def schema_credentials(registry: Path, destination: Path) -> None:
    bindings = []
    for filename in ("journeys.yaml",):
        document = yaml.safe_load(
            (registry / "tests" / filename).read_text(encoding="utf-8")
        )
        for journey in document["journeys"]:
            for step in journey["steps"]:
                profile = step["accessProfile"]
                bindings.append({
                    "journeyId": journey["id"],
                    "stepId": step["id"],
                    "credential": {
                        "type": "bearer",
                        "tokenRef": f"secret:file/token-{profile}",
                    },
                })
    write(destination, {
        "apiVersion": "registry.registrystack.org/breg-schema-test-credentials/v1",
        "kind": "SchemaTestCredentials",
        "bindings": bindings,
    })


def breg_runtime(bindings: dict, *, test: bool) -> dict:
    package_root = "/config/breg/empty-package" if test else "/config/breg/build/package"
    prefix = "test-" if test else ""
    event_destinations = {
        "openfn": {
            "origin": "http://localhost:8081",
            "path": "/events/breg",
            "networkProfile": "loopbackDevelopmentHttp",
            "dnsFamily": "ipv4Only",
            "allowedPrivateCidrs": [],
            "hmacSha256KeyRef": "secret:file/openfn-webhook-key",
            "classificationCeiling": "restricted",
            "deliveryCeilings": {
                "attemptTimeoutMilliseconds": 5000,
                "maximumAttempts": 5,
            },
        },
        "casework": {
            "origin": "http://localhost:8092",
            "path": "/events/sources/agricultural-holdings",
            "networkProfile": "loopbackDevelopmentHttp",
            "dnsFamily": "ipv4Only",
            "allowedPrivateCidrs": [],
            "hmacSha256KeyRef": "secret:file/breg-casework-webhook",
            "classificationCeiling": "restricted",
            "deliveryCeilings": {
                "attemptTimeoutMilliseconds": 5000,
                "maximumAttempts": 5,
            },
        },
    }
    review_authorities = {
        "casework": {
            "endpoint": "http://127.0.0.1:8092",
            "profile": "integration-requester",
            "producerId": "registry-breg",
            "recoveryDays": 7,
            "privateKeyJwt": {
                "tokenEndpoint": bindings["tokenEndpoint"],
                "clientIdRef": "secret:file/casework-producer-client-id",
                "clientAssertionKeyRef": "secret:file/casework-producer-private-jwk",
                "assertionAudience": bindings["clientAssertionAudience"],
                "resource": bindings["resource"],
                "scopes": ["casework:reviews:request"],
                "caBundleRef": "secret:file/pilot-ca.pem",
            },
        },
    }
    return {
        "apiVersion": "registry.registrystack.org/breg-runtime/v1alpha1",
        "kind": "BRegRuntimeConfig",
        "listener": {
            "bind": "127.0.0.1:8090",
            "publicOrigin": "http://127.0.0.1:8090",
        },
        "identity": {
            "environment": "local",
            "instanceId": "agriculture-openfn-pilot-038",
            "databaseId": "agriculture-pilot-038-db",
            "databaseInitializationEnvironment": "local",
        },
        "secretProviders": {"file": {"root": "/config/breg/secrets"}},
        "database": {
            "runtimeUrlRef": f"secret:file/{prefix}runtime-database-url",
            "migrationUrlRef": f"secret:file/{prefix}migration-database-url",
            "pool": {"maxSize": 4},
            "roles": {
                "migration": "agriculture_migration",
                "runtime": "agriculture_runtime",
            },
        },
        "package": {"root": package_root},
        "authentication": {
            "oidc": {
                "issuer": bindings["issuer"],
                "audience": bindings["resource"],
                "allowedAlgorithm": "RS256",
                "accessTokenType": "at+jwt",
                "scopeClaim": "scope",
                "scopeSeparator": " ",
                "allowedClients": [
                    bindings["clients"][logical_id]["clientId"]
                    for logical_id in (
                        "reader", "editor", "reviewer", "openfn-service",
                        "evidence-source", "casework-reader",
                    )
                ],
                "assertionIssuers": {},
                "deniedKids": [],
                "maxTokenLifetimeSeconds": 300,
                "leewayMilliseconds": 30000,
                "jwksSource": {
                    "kind": "static",
                    "documentRef": "secret:file/issuer-jwks",
                },
            },
            "authorityClaims": {
                "principal": "registry_principal",
                "purpose": "registry_purpose",
            },
        },
        "audit": {
            "hashKeyRef": "secret:file/audit-key",
            "destination": "file",
            "path": (
                "/var/lib/registry-breg/test-audit.jsonl"
                if test else "/var/lib/registry-breg/audit.jsonl"
            ),
        },
        "cursor": {"secretRef": "secret:file/cursor-key"},
        "eventDestinations": event_destinations,
        "eventDelivery": {"payloadRetentionDays": 1},
        "reviewAuthorities": review_authorities,
    }


def prepare_casework(root: Path, bins: Path, bindings: dict) -> None:
    casework = root / "casework"
    shutil.copytree(HERE / "casework", casework / "project")
    policy = casework / "project" / "casework.yaml"
    body = policy.read_text(encoding="utf-8")
    if body.count("__CASEWORK_PRODUCER_SUBJECT__") != 1:
        raise RuntimeError("Casework producer subject placeholder is missing or repeated")
    body = body.replace(
        "__CASEWORK_PRODUCER_SUBJECT__",
        bindings["clients"]["casework-producer"]["subject"],
    )
    policy.write_text(body, encoding="utf-8")
    policy.chmod(0o600)
    write(
        casework / "check-report.json",
        run(bins / "caseworkctl", "check", casework / "project", "--format", "json"),
    )
    write(
        casework / "test-report.json",
        run(bins / "caseworkctl", "test", casework / "project", "--format", "json"),
    )
    package_report = json.loads(run(
        bins / "caseworkctl", "package", casework / "project",
        "--output", casework / "package",
        "--revision", "agriculture-openfn-pilot-0.38.0",
        "--format", "json",
    ))
    write(casework / "package-report.json", package_report)
    write(casework / "secrets" / "casework-audit-key", secrets.token_hex(32))
    shutil.copyfile(
        root / "breg" / "secrets" / "breg-casework-webhook",
        casework / "secrets" / "breg-casework-webhook",
    )
    (casework / "secrets" / "breg-casework-webhook").chmod(0o600)
    reader = bindings["clients"]["casework-reader"]
    write(casework / "secrets" / "breg-reader-client-id", reader["clientId"])
    shutil.copyfile(reader["privateJwk"], casework / "secrets" / "breg-reader-key")
    (casework / "secrets" / "breg-reader-key").chmod(0o600)
    write(casework / "runtime.yaml", {
        "apiVersion": "registry.registrystack.org/casework-runtime/v1alpha1",
        "kind": "CaseworkRuntimeConfig",
        "identity": {"databaseId": "agriculture-casework-pilot-038"},
        "package": {
            "root": "/config/casework/package",
            "expectedDigest": package_report["packageDigest"],
        },
        "listener": {
            "bind": "127.0.0.1:8092",
            "tlsTermination": "development-loopback",
            "networkExposure": "private-address",
        },
        "secretProviders": {"file": {"root": "/config/casework/secrets"}},
        "database": {
            "runtimeUrlRef": "secret:file/runtime-database-url",
            "migrationUrlRef": "secret:file/migration-database-url",
            "trustedRootCertificateRef": "secret:file/database-ca.pem",
        },
        "authentication": {"oidc": {
            "issuer": bindings["issuer"],
            "audience": bindings["resource"],
            "scopeClaim": "scope",
            "jwksSource": {
                "kind": "static",
                "documentRef": "secret:file/issuer-jwks",
            },
            "allowedClients": [
                bindings["clients"][logical_id]["clientId"]
                for logical_id in (
                    "reviewer", "casework-admin", "casework-producer",
                )
            ],
            "humanIdentity": {
                "claim": "registry_actor_kind",
                "value": "human",
            },
        }},
        "audit": {
            "path": "/var/lib/registry-casework/audit.ndjson",
            "hashKeyRef": "secret:file/casework-audit-key",
        },
        "sources": {"agricultural-holdings": {
            "baseUrl": "http://127.0.0.1:8090",
            "readerProfile": "casework-reader",
            "tokenEndpoint": bindings["tokenEndpoint"],
            "clientAssertionAudience": bindings["clientAssertionAudience"],
            "resource": bindings["resource"],
            "scopes": ["casework:source-reader"],
            "clientIdRef": "secret:file/breg-reader-client-id",
            "clientAssertionKeyRef": "secret:file/breg-reader-key",
            "trustedRootCertificatesRef": "secret:file/pilot-ca.pem",
            "webhookSecretRef": "secret:file/breg-casework-webhook",
            "eventSource": (
                "urn:registrystack:registry:agricultural-holdings:"
                "instance:agriculture-openfn-pilot-038"
            ),
        }},
    })


def prepare_evidence(root: Path, bins: Path, bindings: dict) -> int:
    evidence = root / "evidence"
    project = evidence / "project"
    shutil.copytree(HERE / "evidence-starter", project)
    write(
        project / "evidence-project.yaml",
        "version: 1\nproject: evidence-authoring\n",
    )
    export = evidence / "source-export"
    run(
        bins / "bregctl", "generate", "evidence-source",
        root / "breg" / "registry",
        "--access-profile", "evidence-source",
        "--entity", "farm",
        "--selector", "by-local-identifier",
        "--fields", "local-identifier",
        "--source-id", "holding-register",
        "--connection", "registry",
        "--output", export,
    )
    with tempfile.TemporaryDirectory(
        prefix=".evidence-authoring-", dir=root
    ) as temporary:
        temporary_root = Path(temporary)
        run(
            bins / "evidencectl", "keygen", "signing",
            "--output-dir", temporary_root / "key",
        )
        run(
            bins / "evidencectl", "target", "new", temporary_root / "target",
            "--settings", project / "targets" / "production" / "settings.yaml",
            "--signing-public-key",
            temporary_root / "key" / "signing-p256-public.jwk.json",
        )
        run(
            bins / "evidencectl", "source", "import", export,
            "--project", project,
            "--target", temporary_root / "target",
        )
        check = run(
            bins / "evidencectl", "check", project,
            "--target", temporary_root / "target",
            "--production", "--format", "json",
        )
        fixtures = run(
            bins / "evidencectl", "test", project,
            "--target", temporary_root / "target",
            "--format", "json",
        )
    write(evidence / "check-report.json", check)
    write(evidence / "fixture-report.json", fixtures)
    (evidence / "secrets").mkdir(mode=0o700)
    for name in ("audit-hmac-key", "subject-binding-hmac-key"):
        run(
            bins / "evidencectl", "keygen", "secret",
            "--output", evidence / "secrets" / name,
        )
    source = bindings["clients"]["evidence-source"]
    write(evidence / "secrets" / "registry-client-id", source["clientId"])
    shutil.copyfile(
        source["privateJwk"], evidence / "secrets" / "registry-client-key"
    )
    (evidence / "secrets" / "registry-client-key").chmod(0o600)
    return int(json.loads(fixtures)["evaluatedCases"])


def prepare(root: Path, bins: Path) -> None:
    if root.exists():
        raise SystemExit("Output exists. Retain it, or choose a new --output directory.")
    check_versions(bins)
    os.environ["PATH"] = str(bins) + os.pathsep + os.environ.get("PATH", "")
    os.environ["EVIDENCE_BIN"] = str(bins / "evidence")
    os.umask(0o077)
    root.mkdir(parents=True, mode=0o700)
    for name in (
        "breg", "casework", "evidence", "evidence-client", "openfn", "bridge",
        "breg-db", "casework-db", "openbao", "evidence/transit-public",
    ):
        (root / name).mkdir(parents=True, exist_ok=True, mode=0o700)

    bindings = prepare_issuer(root, client_descriptors(root))
    write(root / "issuer-bindings.json", bindings)
    ca_bundle = Path(bindings["caBundle"])
    for destination in (
        root / "breg" / "secrets" / "pilot-ca.pem",
        root / "casework" / "secrets" / "pilot-ca.pem",
        root / "evidence" / "tls" / "pilot-ca.pem",
        root / "evidence-client" / "pilot-ca.pem",
    ):
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copyfile(ca_bundle, destination)
        destination.chmod(0o600)

    breg = root / "breg"
    shutil.copytree(HERE / "registry", breg / "registry")
    write(
        breg / "check-report.json",
        run(bins / "bregctl", "check", breg / "registry", "--format", "json"),
    )
    for name in (
        "audit-key", "cursor-key", "openfn-webhook-key", "breg-casework-webhook"
    ):
        write(breg / "secrets" / name, secrets.token_hex(32))
    producer = bindings["clients"]["casework-producer"]
    write(
        breg / "secrets" / "casework-producer-client-id",
        producer["clientId"],
    )
    shutil.copyfile(
        producer["privateJwk"],
        breg / "secrets" / "casework-producer-private-jwk",
    )
    (breg / "secrets" / "casework-producer-private-jwk").chmod(0o600)
    write(breg / "runtime-template.yaml", breg_runtime(bindings, test=False))
    write(breg / "test-runtime.yaml", breg_runtime(bindings, test=True))
    (breg / "empty-package").mkdir(mode=0o700)
    schema_credentials(
        breg / "registry", breg / "schema-test-credentials.json"
    )

    database_files(
        root, "breg", "agriculture",
        ("agriculture_migration", "agriculture_runtime"),
    )
    database_files(
        root, "casework", "agriculture_casework",
        ("casework_migration", "casework_runtime"),
    )
    write(
        breg / "secrets" / "trust-bundle.pem",
        (breg / "secrets" / "database-ca.pem").read_text(encoding="utf-8")
        + ca_bundle.read_text(encoding="utf-8"),
    )
    prepare_casework(root, bins, bindings)
    fixture_count = prepare_evidence(root, bins, bindings)

    evidence_client = bindings["clients"]["openfn-evidence"]
    client_key = root / "evidence-client" / "keys" / "signing-p256-private-jwk"
    client_key.parent.mkdir(mode=0o700)
    shutil.copyfile(evidence_client["privateJwk"], client_key)
    client_key.chmod(0o600)

    write(
        root / "bridge" / "breg-hmac-key",
        (breg / "secrets" / "openfn-webhook-key").read_text(),
    )
    events = {}
    for event in ("farm-created-v1", "farm-patched-v1"):
        sample = json.loads(run(
            bins / "bregctl", "webhook", "sample", breg / "registry",
            "--event", event, "--format", "json",
        ))
        events[event] = {
            "schema": sample["request"]["headers"]["ce-dataschema"],
            "trigger": sample["request"]["body"]["data"]["trigger"],
        }
    write(root / "bridge" / "expected-events.json", events)
    write(root / "bridge" / "allowed-value-fields.json", ["local-identifier"])
    write(
        root / "bridge" / "expected-source",
        "urn:registrystack:registry:agricultural-holdings:"
        "instance:agriculture-openfn-pilot-038",
    )

    openfn = bindings["clients"]["openfn-service"]
    write(root / "openfn" / "breg-credential.json", {"breg": {
        "baseUrl": "http://127.0.0.1:8090",
        "authorization": {"privateKeyJwt": {
            "tokenEndpoint": bindings["tokenEndpoint"],
            "clientId": openfn["clientId"],
            "clientKey": json.loads(
                Path(openfn["privateJwk"]).read_text(encoding="utf-8")
            ),
            "audience": bindings["clientAssertionAudience"],
            "resource": bindings["resource"],
            "scopes": openfn["scopes"],
            "trustedRootCertificates": ca_bundle.read_text(encoding="utf-8"),
        }},
    }})
    write(root / "workflow-bindings.json", {
        "breg": {
            "accessProfile": "openfn-service",
            "farmEntity": "farm",
            "farmCreateOperation": "records.farm.create",
            "selector": "by-local-identifier",
            "correctionEntity": "name-correction",
            "correctionCreateOperation": "records.name-correction.create",
            "correctionSubmitOperation": "records.name-correction.request.submit",
        },
        "evidence": {
            "requirement": "holding-registered",
            "requirementId": REQUIREMENT,
            "selectorProfile": PROFILE,
            "purpose": "holding-verification",
            "registeredConcept": (
                "urn:example:concept:holding-registered:registered"
            ),
        },
    })
    write(root / "prepared.json", {
        "schema": "synthetic-agriculture-pilot/v1",
        "version": VERSION,
        "fixtures": fixture_count,
        "evidencePackage": "pending-transit-public-key",
    })
    secure_prepared_tree(root)
    print(
        "Prepared isolated Registry Stack 0.38 BReg, Casework, "
        "and Evidence authoring inputs."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin-dir", type=Path, required=True)
    parser.add_argument(
        "--output", type=Path, default=HERE / ".runtime-0.38"
    )
    arguments = parser.parse_args()
    prepare(arguments.output.resolve(), arguments.bin_dir.resolve())
