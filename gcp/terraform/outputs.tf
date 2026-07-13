output "region" {
  value = var.region
}

output "cluster_name" {
  value = google_container_cluster.cluster.name
}

output "gke_get_credentials_cmd" {
  description = "Run this to point kubectl at the cluster."
  value       = "gcloud container clusters get-credentials ${google_container_cluster.cluster.name} --region ${var.region} --project ${var.project_id}"
}

output "artifact_registry_repo" {
  description = "Docker image path prefix; push images as <this>/<name>:<tag>."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

# --- Cloud SQL (private) ---
output "db_private_ip" {
  value = google_sql_database_instance.pg.private_ip_address
}

output "db_name" {
  value = google_sql_database.app.name
}

output "db_user" {
  value = google_sql_user.app.name
}

output "db_password" {
  value     = random_password.db.result
  sensitive = true
}

# --- Memorystore (private) ---
output "redis_host" {
  value = google_redis_instance.cache.host
}

output "redis_port" {
  value = google_redis_instance.cache.port
}

output "redis_auth" {
  value     = google_redis_instance.cache.auth_string
  sensitive = true
}
