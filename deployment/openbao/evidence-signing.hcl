path "transit/keys/evidence-signing" {
  capabilities = ["read"]
}

path "transit/sign/evidence-signing/sha2-256" {
  capabilities = ["update"]
  required_parameters = ["input", "key_version", "marshaling_algorithm", "prehashed"]
  allowed_parameters = {
    "input"                 = []
    # OpenBao 2.7 refuses the released client's integer under a numeric
    # allowlist. The runtime pins version 1; startup rejects rotated keys.
    "key_version"           = []
    "marshaling_algorithm" = ["jws"]
    "prehashed"             = [true]
  }
}
