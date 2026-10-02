#!/bin/sh
# Run inside the isolated OpenBao server after it has been unsealed.
set -eu
secret_root=/run/openbao-secrets
export BAO_ADDR=http://127.0.0.1:8200
export BAO_TOKEN="$(cat "$secret_root/root-token")"

# Reconcile the scoped policy on retained starts without rotating key state.
bao policy write evidence-signing /openbao/policy/evidence-signing.hcl >/dev/null

if [ ! -f "$secret_root/transit-configured" ]; then
  bao secrets enable transit >/dev/null
  bao write -f transit/keys/evidence-signing type=ecdsa-p256 >/dev/null
  bao auth enable approle >/dev/null
  bao write auth/approle/role/evidence-signing \
    token_policies=evidence-signing token_ttl=1h token_max_ttl=4h \
    secret_id_ttl=0 secret_id_num_uses=0 >/dev/null
  bao read -field=role_id auth/approle/role/evidence-signing/role-id > "$secret_root/role-id"
  bao write -f -field=secret_id auth/approle/role/evidence-signing/secret-id > "$secret_root/secret-id"
  chmod 0600 "$secret_root/role-id" "$secret_root/secret-id"
  : > "$secret_root/transit-configured"
  chmod 0600 "$secret_root/transit-configured"
fi

metadata="$secret_root/evidence-signing-metadata.json.tmp"
if [ -e "$metadata" ]; then
  printf '%s\n' 'Preserved OpenBao Transit metadata staging file exists; inspect recovery state before retrying.' >&2
  exit 1
fi
(umask 077; set -C; bao read -format=json transit/keys/evidence-signing > "$metadata")
