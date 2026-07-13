# Regional VPC-native GKE cluster (control plane + nodes across 3 zones for HA).

resource "google_container_cluster" "cluster" {
  name       = "${var.prefix}-gke"
  location   = var.region
  network    = google_compute_network.vpc.id
  subnetwork = google_compute_subnetwork.subnet.id

  # Manage node pools separately.
  remove_default_node_pool = true
  initial_node_count       = 1

  # VPC-native: bind Pod/Service IPs to the subnet's secondary ranges.
  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  # Keep the control plane reachable from the operator's machine (public endpoint).
  # Nodes themselves are private but the demo does not lock down master access.
  deletion_protection = false

  depends_on = [google_project_service.enabled]
}

resource "google_container_node_pool" "primary" {
  name     = "${var.prefix}-pool"
  location = var.region
  cluster  = google_container_cluster.cluster.name

  # Per-zone count; a regional cluster spans 3 zones => 3x these numbers.
  initial_node_count = var.gke_min_nodes

  autoscaling {
    min_node_count = var.gke_min_nodes
    max_node_count = var.gke_max_nodes
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  node_config {
    machine_type = var.gke_machine_type
    disk_size_gb = 50
    oauth_scopes = ["https://www.googleapis.com/auth/cloud-platform"]

    # Nodes keep default egress (only Cloud SQL/Redis are required to be
    # public-IP-free); Cloud NAT is present regardless so image pulls work.
    shielded_instance_config {
      enable_secure_boot = true
    }
  }
}
