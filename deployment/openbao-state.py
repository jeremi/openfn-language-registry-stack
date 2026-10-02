#!/usr/bin/env python3
"""Move bounded OpenBao bootstrap output into owner-only pilot files."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import urllib.error
import urllib.request


def private_write(path: Path, value: str) -> None:
    if path.exists():
        raise RuntimeError(f"refusing to overwrite retained OpenBao state: {path.name}")
    with path.open("x", encoding="utf-8") as handle:
        handle.write(value.rstrip("\n") + "\n")
    path.chmod(0o600)


def bounded_json(path: Path) -> dict:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 64 * 1024:
        raise RuntimeError("OpenBao bootstrap output is not a bounded ordinary file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("OpenBao bootstrap output is malformed") from error
    if not isinstance(value, dict):
        raise RuntimeError("OpenBao bootstrap output is malformed")
    return value


def record_init(root: Path) -> None:
    temporary = root / "init.json.tmp"
    document = bounded_json(temporary)
    keys = document.get("unseal_keys_b64")
    token = document.get("root_token")
    if not isinstance(keys, list) or len(keys) != 1 or not isinstance(keys[0], str) or not keys[0]:
        raise RuntimeError("OpenBao did not return the one requested unseal share")
    if not isinstance(token, str) or not token:
        raise RuntimeError("OpenBao did not return a root token")
    private_write(root / "unseal-key", keys[0])
    private_write(root / "root-token", token)
    temporary.unlink()


def record_public(runtime: Path, evidencectl: Path) -> None:
    openbao = runtime / "openbao"
    temporary = openbao / "evidence-signing-metadata.json.tmp"
    document = bounded_json(temporary)
    try:
        data = document["data"]
        keys = data["keys"]
        key = keys["1"]
        pem = key["public_key"]
    except (KeyError, TypeError) as error:
        raise RuntimeError("OpenBao Transit metadata omitted key version 1") from error
    if (
        not isinstance(data, dict)
        or not isinstance(keys, dict)
        or set(keys) != {"1"}
        or data.get("latest_version") != 1
        or data.get("auto_rotate_period") != 0
        or data.get("type") != "ecdsa-p256"
        or data.get("derived") is not False
        or data.get("deletion_allowed") is not False
        or data.get("exportable") is not False
        or data.get("allow_plaintext_backup") is not False
        or data.get("imported_key") is not False
        or data.get("soft_deleted") is not False
        or data.get("supports_signing") is not True
    ):
        raise RuntimeError("OpenBao Transit key is not the retained single-version signing key")
    if not isinstance(pem, str) or "BEGIN PUBLIC KEY" not in pem or "PRIVATE" in pem:
        raise RuntimeError("OpenBao Transit returned an invalid public key")
    output_dir = runtime / "evidence" / "transit-public"
    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    pem_path = output_dir / "evidence-signing.pem"
    jwk_path = output_dir / "evidence-signing.jwk.json"
    if pem_path.exists() or jwk_path.exists():
        if not pem_path.is_file() or not jwk_path.is_file() or pem_path.read_text(encoding="utf-8").strip() != pem.strip():
            raise RuntimeError("retained Evidence Transit public key does not match provider version 1")
        temporary.unlink()
        return
    private_write(pem_path, pem)
    result = subprocess.run(
        [str(evidencectl), "jwk", "from-pem", str(pem_path), "--output", str(jwk_path)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode:
        raise RuntimeError("evidencectl refused the OpenBao Transit public key")
    jwk_path.chmod(0o600)
    temporary.unlink()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def unseal(root: Path) -> None:
    key_path = root / "unseal-key"
    metadata = key_path.lstat()
    if key_path.is_symlink() or not key_path.is_file() or metadata.st_mode & 0o077:
        raise RuntimeError("OpenBao unseal key is not an owner-only ordinary file")
    if metadata.st_size > 4096:
        raise RuntimeError("OpenBao unseal key is unexpectedly large")
    key = key_path.read_text(encoding="ascii").strip()
    if not key or any(character.isspace() for character in key):
        raise RuntimeError("OpenBao unseal key is malformed")
    request = urllib.request.Request(
        "http://127.0.0.1:8200/v1/sys/unseal",
        data=json.dumps({"key": key}, separators=(",", ":")).encode("ascii"),
        method="PUT",
        headers={"Content-Type": "application/json"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=5) as response:
            body = response.read(65537)
            if response.status != 200 or len(body) > 65536:
                raise RuntimeError("OpenBao refused the unseal share")
    except (urllib.error.URLError, TimeoutError) as error:
        raise RuntimeError("OpenBao unseal request failed") from error
    try:
        document = json.loads(body)
    except json.JSONDecodeError as error:
        raise RuntimeError("OpenBao returned a malformed unseal response") from error
    if not isinstance(document, dict) or document.get("sealed") is not False:
        raise RuntimeError("OpenBao remains sealed after accepting the configured share")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    init = subcommands.add_parser("record-init")
    init.add_argument("openbao_root", type=Path)
    public = subcommands.add_parser("record-public")
    public.add_argument("runtime_root", type=Path)
    public.add_argument("--evidencectl", type=Path, default=Path("/usr/local/bin/evidencectl"))
    unseal_parser = subcommands.add_parser("unseal")
    unseal_parser.add_argument("openbao_root", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == "record-init":
        record_init(args.openbao_root.resolve())
    elif args.command == "record-public":
        record_public(args.runtime_root.resolve(), args.evidencectl)
    else:
        unseal(args.openbao_root.resolve())


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(f"OpenBao state preparation failed: {error}")
