variable "project_id" {
  type        = string
  description = "GCP project ID to deploy into."
}

variable "region" {
  type        = string
  description = "GCP region for the regional GKE cluster and all resources."
  default     = "us-central1"
}

variable "prefix" {
  type        = string
  description = "Name prefix for all resources (lets several demos coexist in one project)."
  default     = "quota-demo"
}

# --- GKE node pool ---
variable "gke_machine_type" {
  type        = string
  description = "Machine type for GKE nodes."
  default     = "e2-standard-4"
}

variable "gke_min_nodes" {
  type        = number
  description = "Min nodes per zone (regional cluster => x3 zones). 1 => 3 nodes, enough for 3x3 base replicas."
  default     = 1
}

variable "gke_max_nodes" {
  type        = number
  description = "Max nodes per zone for cluster autoscaling (headroom for the enforcer HPA scaling to 10)."
  default     = 3
}

# --- Cloud SQL (Postgres) ---
variable "db_tier" {
  type        = string
  description = "Cloud SQL machine tier."
  default     = "db-custom-2-7680"
}

variable "db_version" {
  type        = string
  description = "Cloud SQL Postgres version."
  default     = "POSTGRES_16"
}

variable "db_name" {
  type        = string
  description = "Application database name (matches the services' PGDATABASE default)."
  default     = "quota"
}

variable "db_user" {
  type        = string
  description = "Application database user."
  default     = "postgres"
}

# --- Memorystore (Redis) ---
variable "redis_memory_gb" {
  type        = number
  description = "Memorystore capacity in GiB."
  default     = 1
}

variable "redis_version" {
  type        = string
  description = "Memorystore Redis version."
  default     = "REDIS_7_0"
}

# --- networking ---
variable "subnet_cidr" {
  type        = string
  description = "Primary subnet range for nodes."
  default     = "10.10.0.0/20"
}

variable "pods_cidr" {
  type        = string
  description = "Secondary range for GKE Pods (VPC-native)."
  default     = "10.20.0.0/16"
}

variable "services_cidr" {
  type        = string
  description = "Secondary range for GKE Services (VPC-native)."
  default     = "10.30.0.0/20"
}
