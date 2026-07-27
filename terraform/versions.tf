terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # state は GCS に置く。バケットはこの構成では管理しない
  # （terraform destroy で state 置き場ごと消えるのを避けるため）。
  # 作成は bootstrap.sh を参照。
  backend "gcs" {
    bucket = "toshima-tennis-tfstate"
    prefix = "webhook"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
