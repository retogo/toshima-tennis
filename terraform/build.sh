#!/usr/bin/env bash
# webhook / Job 共用のコンテナをビルドして Artifact Registry に push する。
# bootstrap.sh のあと、terraform apply の前に実行する。
#
# タグに git のコミットハッシュを使い、結果を image.auto.tfvars に書き出す。
# :latest 固定だとタグ文字列が変わらないため、terraform apply が「変更なし」と
# 判断して新しいイメージが反映されない。
set -euo pipefail

cd "$(dirname "$0")"

# terraform apply より前に走るため、terraform output には依存しない
PROJECT_ID="${PROJECT_ID:-toshima-tennis}"
LOCATION="${LOCATION:-asia-northeast1}"
REPOSITORY="${REPOSITORY:-toshima-tennis}"
REPO="${LOCATION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/webhook"

TAG=$(git rev-parse --short HEAD)
if ! git -C .. diff --quiet HEAD; then
  # 未コミットの変更を含むイメージだと分かるようにする
  TAG="${TAG}-dirty$(git -C .. diff HEAD | shasum | cut -c1-7)"
fi
IMAGE="${REPO}:${TAG}"

echo "building ${IMAGE}"
gcloud builds submit .. --project "${PROJECT_ID}" --tag "${IMAGE}"

# *.auto.tfvars は terraform が自動で読み込む
printf 'image = "%s"\n' "${IMAGE}" > image.auto.tfvars

echo
echo "image.auto.tfvars を更新しました:"
cat image.auto.tfvars
echo "terraform apply で反映してください"
