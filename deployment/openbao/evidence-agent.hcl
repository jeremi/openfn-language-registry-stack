pid_file = "/run/registry-evidence/transit-proxy.pid"

vault {
  address = "http://127.0.0.1:8200"
  retry {
    num_retries = -1
  }
}

auto_auth {
  method "approle" {
    mount_path = "auth/approle"
    config = {
      role_id_file_path                   = "/run/openbao-credentials/role-id"
      secret_id_file_path                 = "/run/openbao-credentials/secret-id"
      remove_secret_id_file_after_reading = false
    }
  }
}

api_proxy {
  use_auto_auth_token = "force"
}

listener "unix" {
  address                = "/run/registry-evidence/transit-proxy.sock"
  tls_disable            = true
  socket_mode            = "0600"
  require_request_header = true
}
