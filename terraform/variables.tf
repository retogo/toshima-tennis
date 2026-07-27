variable "project_id" {
  description = "デプロイ先の GCP プロジェクト ID"
  type        = string
}

variable "region" {
  description = "Cloud Run と Artifact Registry のリージョン"
  type        = string
  default     = "asia-northeast1"
}

variable "service_name" {
  description = "Cloud Run サービス名"
  type        = string
  default     = "toshima-tennis-webhook"
}

variable "name_prefix" {
  description = "サービスアカウントや Job の名前に使う接頭辞（SA の ID は 30 文字まで）"
  type        = string
  default     = "toshima"
}

variable "poll_schedule" {
  description = "ポーリングの cron（time_zone は Asia/Tokyo）"
  type        = string
  default     = "*/10 8-23 * * *"
}

variable "image" {
  description = <<-EOT
    Cloud Run にデプロイするコンテナイメージ。build.sh が image.auto.tfvars に
    書き出すため通常は指定しない。
    省略時は :latest を指すが、タグが変わらないと terraform が更新を
    検知できないため、初回以外は build.sh 経由で固有のタグを使うこと。
  EOT
  type        = string
  default     = null
}
