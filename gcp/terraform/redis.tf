# Memorystore for Redis — PRIVATE_SERVICE_ACCESS (no public IP), on the same VPC
# peering as Cloud SQL. AUTH enabled; the auth string is surfaced as an output.

resource "google_redis_instance" "cache" {
  name           = "${var.prefix}-redis"
  region         = var.region
  tier           = "STANDARD_HA" # HA with a replica
  memory_size_gb = var.redis_memory_gb
  redis_version  = var.redis_version

  connect_mode            = "PRIVATE_SERVICE_ACCESS"
  authorized_network      = google_compute_network.vpc.id
  auth_enabled            = true
  transit_encryption_mode = "DISABLED" # plaintext within the private VPC (demo)

  depends_on = [google_service_networking_connection.psa]
}
