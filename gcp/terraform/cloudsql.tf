# Cloud SQL for PostgreSQL — PRIVATE IP ONLY (ipv4_enabled = false). Reachable
# from GKE pods over the private-services-access peering; no public endpoint.

resource "random_password" "db" {
  length  = 24
  special = false
}

resource "google_sql_database_instance" "pg" {
  name             = "${var.prefix}-pg"
  region           = var.region
  database_version = var.db_version

  # Do not block terraform destroy for the demo.
  deletion_protection = false

  depends_on = [google_service_networking_connection.psa]

  settings {
    tier              = var.db_tier
    availability_type = "REGIONAL" # HA (synchronous standby in another zone)

    ip_configuration {
      ipv4_enabled    = false # <-- no public IP
      private_network = google_compute_network.vpc.id
    }

    backup_configuration {
      enabled = true
    }
  }
}

resource "google_sql_database" "app" {
  name     = var.db_name
  instance = google_sql_database_instance.pg.name
}

resource "google_sql_user" "app" {
  name     = var.db_user
  instance = google_sql_database_instance.pg.name
  password = random_password.db.result
}
