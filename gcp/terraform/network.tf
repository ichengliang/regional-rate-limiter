# VPC + private networking. Cloud SQL and Memorystore get NO public IP; they are
# reached from GKE pods over a private-services-access peering on this VPC.

resource "google_compute_network" "vpc" {
  name                    = "${var.prefix}-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.enabled]
}

resource "google_compute_subnetwork" "subnet" {
  name          = "${var.prefix}-subnet"
  region        = var.region
  network       = google_compute_network.vpc.id
  ip_cidr_range = var.subnet_cidr

  # Secondary ranges make the GKE cluster VPC-native (alias IPs). Pod IPs are then
  # first-class VPC addresses and can route to the private-services-access peering,
  # which is how pods reach the private Cloud SQL / Redis IPs.
  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.pods_cidr
  }
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = var.services_cidr
  }

  private_ip_google_access = true
}

# --- Private Services Access: reserved range + peering used by BOTH Cloud SQL
# and Memorystore (connect_mode = PRIVATE_SERVICE_ACCESS). ---
resource "google_compute_global_address" "psa_range" {
  name          = "${var.prefix}-psa-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa_range.name]
  depends_on              = [google_project_service.enabled]
}

# --- Cloud NAT: egress for nodes without external IPs (image pulls, apt, npm).
# Harmless if nodes have external IPs; makes the setup work either way. ---
resource "google_compute_router" "router" {
  name    = "${var.prefix}-router"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_router_nat" "nat" {
  name                               = "${var.prefix}-nat"
  router                             = google_compute_router.router.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}
