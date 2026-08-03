locals {
  repository_id = "toshima-tennis"

  image = coalesce(
    var.image,
    "${var.region}-docker.pkg.dev/${var.project_id}/${local.repository_id}/webhook:latest",
  )

  # Cloud Run に環境変数として渡す秘密情報。
  # **値は Terraform で管理しない**（state に平文で残るため）。
  # ここでは入れ物だけ作り、値は gcloud secrets versions add で入れる。
  # すべての秘密情報の入れ物。値は Terraform で管理しない。
  secrets = {
    LINE_CHANNEL_SECRET       = "line-channel-secret"
    LINE_CHANNEL_ACCESS_TOKEN = "line-channel-access-token"
    LINE_TO                   = "line-to"
    TOSHIMA_USER_ID           = "toshima-user-id"
    TOSHIMA_PASSWORD          = "toshima-password"
  }

  # webhook は予約システムの認証情報を持たない（Job を起動するだけ）
  webhook_secrets = ["LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "LINE_TO"]

  # poll も予約システムにログインする。auto モードでの予約に加え、月上限の判定と
  # 予約一覧のキャッシュ（LINE の状況表示用）で予約一覧を読むため。
  # ここが LINE_* だけだと auto に切り替えた瞬間に認証情報が無くて落ちる。
  poll_secrets = [
    "LINE_CHANNEL_ACCESS_TOKEN",
    "LINE_TO",
    "TOSHIMA_USER_ID",
    "TOSHIMA_PASSWORD",
  ]

  # reserve は実際に予約するので全部要る
  reserve_secrets = [
    "LINE_CHANNEL_ACCESS_TOKEN",
    "LINE_TO",
    "TOSHIMA_USER_ID",
    "TOSHIMA_PASSWORD",
  ]

  state_bucket = "${var.project_id}-state"

  # artifactregistry と cloudbuild は bootstrap.sh で有効化済み
  services = [
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudscheduler.googleapis.com",
  ]
}

resource "google_project_service" "enabled" {
  for_each = toset(local.services)

  service = each.value

  # terraform destroy で API まで無効化すると他に影響しうるので残す
  disable_on_destroy = false
}

# イメージの push 先。Cloud Run はイメージが存在しないと作成に失敗するため、
# terraform apply より前に build できている必要がある。bootstrap.sh で作る。
data "google_artifact_registry_repository" "containers" {
  location      = var.region
  repository_id = local.repository_id
}

# --- 秘密情報の入れ物 ---
# 値は Terraform の管理外。作成後に手で入れる:
#   printf '%s' "$VALUE" | gcloud secrets versions add line-channel-secret --data-file=-
resource "google_secret_manager_secret" "this" {
  for_each = local.secrets

  secret_id = each.value

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

# --- Cloud Run のサービスアカウント ---
# 既定のサービスアカウントは権限が広いので専用のものを用意し、
# 必要な secret の読み取りだけを与える。
resource "google_service_account" "webhook" {
  account_id   = "${var.name_prefix}-webhook"
  display_name = "toshima-tennis webhook"
}

resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = google_secret_manager_secret.this

  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.webhook.email}"
}

resource "google_cloud_run_v2_service" "webhook" {
  name     = var.service_name
  location = var.region

  deletion_protection = false

  # LINE から呼ばれるため外部からの疎通を許可する。
  # 認証は署名検証（X-Line-Signature）と userId 照合で行う。
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.webhook.email

    scaling {
      # 通知は月数通なので常時起動させない。コールドスタートは許容する。
      min_instance_count = 0
      max_instance_count = 3
    }

    containers {
      image = local.image

      ports {
        container_port = 8080
      }

      env {
        name  = "GCP_PROJECT"
        value = var.project_id
      }

      env {
        name  = "GCP_REGION"
        value = var.region
      }

      env {
        name  = "RESERVE_JOB"
        value = google_cloud_run_v2_job.reserve.name
      }

      env {
        name  = "CANCEL_JOB"
        value = google_cloud_run_v2_job.cancel.name
      }

      # 承認（自動取消の対象から外す）を記録するため。予約システムの
      # 認証情報は依然として持たない。
      env {
        name  = "STATE_BUCKET"
        value = google_storage_bucket.state.name
      }

      dynamic "env" {
        for_each = toset(local.webhook_secrets)

        content {
          name = env.value

          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.this[env.value].secret_id
              version = "latest"
            }
          }
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        # リクエスト処理中だけ CPU を使う（待機中は課金しない）
        cpu_idle = true
      }
    }
  }

  depends_on = [
    google_project_service.enabled,
    google_secret_manager_secret_iam_member.accessor,
  ]
}

# LINE からの POST を受けるため未認証呼び出しを許可する
resource "google_cloud_run_v2_service_iam_member" "public" {
  project  = google_cloud_run_v2_service.webhook.project
  location = google_cloud_run_v2_service.webhook.location
  name     = google_cloud_run_v2_service.webhook.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
