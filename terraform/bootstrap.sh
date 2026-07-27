#!/usr/bin/env bash
# Terraform を動かす前に用意しておくもの。初回に一度だけ実行する。
#
#   CLOUDSDK_CONFIG=~/.config/gcloud-toshima ./bootstrap.sh
#
# ここで作るのは「Terraform が構成を記述する前に存在していないと困るもの」だけ。
#   - state バケット: Terraform 管理下に置くと destroy で state ごと消える
#   - Artifact Registry: イメージの push 先。Cloud Run はイメージが存在しないと
#     作成に失敗するため、terraform apply より前に build できる必要がある
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-toshima-tennis}"
LOCATION="${LOCATION:-asia-northeast1}"
REPOSITORY="${REPOSITORY:-toshima-tennis}"
BUCKET="gs://${PROJECT_ID}-tfstate"

echo "--- API を有効化"
gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  --project="${PROJECT_ID}"

echo "--- state バケット"
if gcloud storage buckets describe "${BUCKET}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "${BUCKET} は既に存在します"
else
  gcloud storage buckets create "${BUCKET}" \
    --project="${PROJECT_ID}" \
    --location="${LOCATION}" \
    --uniform-bucket-level-access \
    --public-access-prevention
  # state を壊したときに戻せるようにする
  gcloud storage buckets update "${BUCKET}" --versioning
  echo "作成しました: ${BUCKET}"
fi

echo "--- Artifact Registry"
if gcloud artifacts repositories describe "${REPOSITORY}" \
  --project="${PROJECT_ID}" --location="${LOCATION}" >/dev/null 2>&1; then
  echo "${REPOSITORY} は既に存在します"
else
  gcloud artifacts repositories create "${REPOSITORY}" \
    --project="${PROJECT_ID}" \
    --location="${LOCATION}" \
    --repository-format=docker \
    --description="toshima-tennis のコンテナ"
  echo "作成しました: ${REPOSITORY}"
fi

echo
echo "次: ./build.sh でイメージを push してから terraform apply"
