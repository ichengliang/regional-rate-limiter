# Docker registry for the three service images.
resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "${var.prefix}-images"
  format        = "DOCKER"
  description   = "Rate-limiter demo images (quotamgmt / quotaenforcer / quotaui)."
  depends_on    = [google_project_service.enabled]
}
