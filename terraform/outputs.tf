output "webhook_url" {
  description = "LINE Developers コンソールに登録する Webhook URL"
  value       = "${google_cloud_run_v2_service.webhook.uri}/webhook"
}

output "service_url" {
  description = "Cloud Run サービスの URL"
  value       = google_cloud_run_v2_service.webhook.uri
}

output "image_repository" {
  description = "コンテナイメージの push 先"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${data.google_artifact_registry_repository.containers.repository_id}/webhook"
}

output "secret_ids" {
  description = "値を入れる必要がある Secret Manager のシークレット"
  value       = [for s in google_secret_manager_secret.this : s.secret_id]
}

output "poll_job" {
  description = "手動実行するときの Job 名"
  value       = google_cloud_run_v2_job.poll.name
}

output "reserve_job" {
  value = google_cloud_run_v2_job.reserve.name
}

output "state_bucket" {
  description = "前回の空き状況と予約済みコマの置き場"
  value       = google_storage_bucket.state.name
}
