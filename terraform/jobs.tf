# 空き状況のポーリングと予約実行。どちらも同じイメージで、
# 起動するスクリプトだけを変える。

# 実行をまたいで持ち回す状態（前回の空き状況・予約済みコマ）の置き場。
# 予約済みの記録が消えると二重予約や月上限の誤りにつながるため、
# バージョニングを有効にして戻せるようにする。
resource "google_storage_bucket" "state" {
  name     = local.state_bucket
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  depends_on = [google_project_service.enabled]
}

resource "google_service_account" "job" {
  account_id   = "${var.name_prefix}-job"
  display_name = "toshima-tennis jobs"
}

resource "google_storage_bucket_iam_member" "job_state" {
  bucket = google_storage_bucket.state.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.job.email}"
}

resource "google_secret_manager_secret_iam_member" "job_accessor" {
  for_each = google_secret_manager_secret.this

  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.job.email}"
}

locals {
  job_common_env = {
    STATE_BUCKET = google_storage_bucket.state.name
  }
}

resource "google_cloud_run_v2_job" "poll" {
  name                = "${var.name_prefix}-poll"
  location            = var.region
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.job.email
      timeout         = "300s"
      max_retries     = 1

      containers {
        image   = local.image
        command = ["bun", "run", "scripts/poll.ts"]

        dynamic "env" {
          for_each = local.job_common_env

          content {
            name  = env.key
            value = env.value
          }
        }

        dynamic "env" {
          for_each = toset(local.poll_secrets)

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
        }
      }
    }
  }

  depends_on = [google_secret_manager_secret_iam_member.job_accessor]
}

resource "google_cloud_run_v2_job" "reserve" {
  name                = "${var.name_prefix}-reserve"
  location            = var.region
  deletion_protection = false

  template {
    template {
      service_account = google_service_account.job.email
      timeout         = "600s"
      # 予約は不可逆なので自動で再試行しない
      max_retries = 0

      containers {
        image   = local.image
        command = ["bun", "run", "scripts/reserve-one.ts"]

        dynamic "env" {
          for_each = local.job_common_env

          content {
            name  = env.key
            value = env.value
          }
        }

        dynamic "env" {
          for_each = toset(local.reserve_secrets)

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
        }
      }
    }
  }

  depends_on = [google_secret_manager_secret_iam_member.job_accessor]
}

# webhook から reserve Job を起動できるようにする
resource "google_cloud_run_v2_job_iam_member" "webhook_runs_reserve" {
  project  = google_cloud_run_v2_job.reserve.project
  location = google_cloud_run_v2_job.reserve.location
  name     = google_cloud_run_v2_job.reserve.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.webhook.email}"
}

# --- 定期実行 ---
resource "google_service_account" "scheduler" {
  account_id   = "${var.name_prefix}-scheduler"
  display_name = "toshima-tennis scheduler"
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_poll" {
  project  = google_cloud_run_v2_job.poll.project
  location = google_cloud_run_v2_job.poll.location
  name     = google_cloud_run_v2_job.poll.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "poll" {
  name        = "${var.name_prefix}-poll"
  region      = var.region
  description = "テニスコートの空き状況を確認する"

  # 深夜に通知が来ても行動できず、公共システムへの無駄なアクセスも減らせる。
  # Cloud Scheduler は時刻の指定にタイムゾーンを使えるので UTC 換算は不要。
  schedule  = var.poll_schedule
  time_zone = "Asia/Tokyo"

  attempt_deadline = "320s"

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.poll.name}:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }

  depends_on = [google_project_service.enabled]
}
