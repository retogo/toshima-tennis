# toshima-tennis

豊島区の公共施設予約システム（<https://www2.pf489.com/Toshima/webR>）を対象に、
テニスコートの空き状況確認・予約を自動化するツール。

## 対象システムの特性

- ASP.NET MVC ベースのセッション型システム（`ASP.NET_SessionId` cookie 必須）
- 純粋な REST API は存在しないため、画面遷移順の form POST を再現する HTTP クライアントとして実装する
- エントリーポイント: `Home/StartPage/`
- 予約実行にはログイン（利用者番号）が必要

## セットアップ

```bash
bun install
```

## コマンド

```bash
bun run poll          # 空き状況を確認して通知（ローカル実行）
bun run reserve       # 1 コマを予約（RESERVE_SLOT で指定）
bun run probe         # 予約フローの画面構造を調査
bun run notify:test   # LINE への疎通確認

bun test              # テスト
bun run typecheck     # 型検査

bun run bootstrap     # 初回のみ: state バケットと Artifact Registry
bun run image         # コンテナをビルドして push
bun run plan          # terraform plan
bun run apply         # terraform apply
bun run deploy        # image + apply
```

`plan` / `apply` には引数をそのまま渡せる（例: `bun run apply -auto-approve`）。

## 構成

GitHub には依存しない。すべて GCP 上で動く。

```
Cloud Scheduler (JST 08:00-24:00 / 10分間隔)
  → Cloud Run Job: poll
       空き状況を確認 → GCS の状態と比較 → 変化があれば LINE に通知
       approve モードなら候補をボタン付きで送る

LINE のボタンをタップ
  → Cloud Run Service: webhook
       X-Line-Signature を検証 / 送信者 userId を照合
  → Cloud Run Job: reserve
       空き状況を取り直し → 確定前照合 → 予約 → LINE に結果を通知
```

| 要素 | 役割 |
| --- | --- |
| `scripts/poll.ts` | ポーリングと通知（Job） |
| `scripts/reserve-one.ts` | 1 コマの予約（Job） |
| `server/index.ts` | LINE webhook（Service） |
| GCS `<project>-state` | 前回の空き状況・予約済みコマ |
| Secret Manager | LINE と予約システムの認証情報 |

### 通知の絞り込み

空きが続く限り通知が飛ばないよう、空きコマ一覧を署名文字列に正規化して
前回と比較し、**変化したエッジでのみ**通知する（`src/notify.ts`）。

さらに、**署名は希望条件（`reserve.json` の `wishes`）に一致するコマだけ**で作る。
全コマで作ると、興味のない曜日・時間帯の増減でも通知が鳴ってしまうため
（実測で空き 13 件がすべて平日、希望条件の土日は 0 件という状態が起きていた）。
判定は `src/notifiable.ts`。

### 権限の分離

webhook は公開エンドポイントなので、**予約システムの認証情報を持たせない**。
Job を起動するだけで、利用者番号もパスワードも知らない。

**公式アカウントは誰でも友だち追加できる。**署名検証だけでは第三者が予約を
叩けるため、送信者 userId の照合は外せない。

## 動作モード

`reserve.json` の `mode` で自動化の度合いを変える。

| mode | 挙動 |
| --- | --- |
| `notify` | 予約せず通知だけ（既定） |
| `approve` | 候補をボタン付きで通知し、押されたら予約 |
| `auto` | 条件に一致したらその場で予約確定 |

| 項目 | 内容 |
| --- | --- |
| `wishes[].daysOfWeek` | 0（日）〜6（土）。省略時は曜日を問わない |
| `wishes[].timeRanges` | `"9:00～11:00"` 形式。省略時は時間帯を問わない |
| `wishes[].courts` | 面番号。省略時は面を問わない |
| `maxPerRun` | 1 回の実行で予約する件数の上限 |
| `maxPerMonth` | 暦月あたりの予約件数の上限（予約済み分も数える） |
| `ninzu` | 利用人数 |
| `gyoujiMeishou` | 行事名称。既定値 `テニス` |
| `mokuteki` | `tennis` / `softTennis`。既定値 `tennis` |

### 確定前の照合

予約の確定は不可逆なため、申込確認画面に表示されている利用日・時間帯・面が
予約したいコマと一致することを確かめてから確定 POST を送る。
一致しなければ確定せずに中断する。

### 予約に伴う責任

- **施設使用料 2,000 円（当日払い・窓口）**
- **取消は使用日の 1 週間前（同一曜日）まで。**
  過ぎると窓口または電話での受付となり、キャンセル料が発生する
- 予約が成立すると LINE に通知が届く。本文に取消期限を記載している

## LINE の準備

通知に LINE Messaging API を使う。LINE Notify は 2025-03-31 に終了しており、
現行の代替がこれになる。Terraform provider もチャネル作成の公開 API も存在
しないため、以下は手作業になる。

**1. 公式アカウントを作る**

[作成フォーム](https://entry.line.biz/form/entry/unverified)から登録する。
2025-06-25 以降の新規開設はビジネスマネージャーへの接続が必須だが、
組織作成時の**ビジネスタイプで「個人」を選べば法人番号は不要**。
緑バッジの「認証済アカウント」審査は別物で任意。

**2. Messaging API を有効にする**

[LINE Official Account Manager](https://manager.line.biz/) で
「設定 → Messaging API」から有効にする。ここでチャネルが作られる。

**3. 応答メッセージをオフにする**

「設定 → 応答設定」で応答メッセージをオフに。push しか使わないため。

**4. ボットを友だち追加する**

[Developers コンソール](https://developers.line.biz/console/)の
「Messaging API設定」タブの QR コードを読み取る。
**友だち追加していないと push が届かない。**

**5. 値を 3 つ取得する**

| 値 | 場所 |
| --- | --- |
| チャネルアクセストークン | 「Messaging API設定」タブ下部で発行 |
| チャネルシークレット | 「チャネル基本設定」タブ |
| 自分のユーザー ID | 「チャネル基本設定」タブ（`U` で始まる 33 文字） |

**通数の上限に注意。** コミュニケーションプラン（月額無料）は月 200 通までで、
超過分は課金ではなく送信不可になる。通知対象を希望条件に絞ってあるため
通常は月数通で収まるが、条件を広げるときは意識すること。

## デプロイ

### 1. gcloud を分離する

`CLOUDSDK_CONFIG` で gcloud の状態一式（アカウント・設定・ADC）を
別ディレクトリに切り出す。既定の `~/.config/gcloud` には触れない。

```bash
export CLOUDSDK_CONFIG=~/.config/gcloud-toshima

gcloud auth login
gcloud auth application-default login
gcloud config set project toshima-tennis
gcloud config set compute/region asia-northeast1

# Terraform は CLOUDSDK_CONFIG を見ないので ADC を明示する
export GOOGLE_APPLICATION_CREDENTIALS="$CLOUDSDK_CONFIG/application_default_credentials.json"
```

**`CLOUDSDK_CONFIG` だけでは Terraform に効かない。** gcloud 自身はこの変数で
設定ディレクトリを切り替えるが、Terraform（Go の認証ライブラリ）はこれを見ず
`~/.config/gcloud/application_default_credentials.json` を直接読みにいく。
名前付き設定（`gcloud config configurations`）でも同じ理由で不十分。

`terraform/.envrc.example` を direnv で使えば毎回打たずに済む。

### 2. 先に用意するものを作る

初回のみ。**Terraform が構成を記述する前に存在していないと困るもの**だけを作る。
state バケット（Terraform 管理下に置くと `destroy` で state ごと消える）と
Artifact Registry（Cloud Run はイメージが無いと作成に失敗するため、apply より
前に build できる必要がある）。

```bash
bun run bootstrap
```

### 3. シークレットの入れ物を作って値を入れる

シークレットは Terraform で入れ物だけ作るが、Cloud Run より先に値が要る。
先に入れ物だけ作ってしまう。

```bash
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
terraform -chdir=terraform init
bun run apply -target=google_secret_manager_secret.this
```

**値は Terraform で管理しない**（state に平文が残るため）。

```bash
printf '%s' '<チャネルアクセストークン>' | gcloud secrets versions add line-channel-access-token --data-file=-
printf '%s' '<チャネルシークレット>'     | gcloud secrets versions add line-channel-secret --data-file=-
printf '%s' '<ユーザーID>'               | gcloud secrets versions add line-to --data-file=-
printf '%s' '<利用者番号>'               | gcloud secrets versions add toshima-user-id --data-file=-
printf '%s' '<パスワード>'               | gcloud secrets versions add toshima-password --data-file=-
```

### 4. コンテナをビルドする

```bash
bun run image
```

git のコミットハッシュでタグを打ち、`terraform/image.auto.tfvars` に書き出す。

### 5. 残りをまとめて作る

```bash
bun run apply
```

### 6. Webhook URL を登録する

```bash
terraform output webhook_url
```

Developers コンソールの「Messaging API設定 → Webhook URL」に設定し、
「Webhookの利用」をオンにする。「検証」ボタンで疎通を確認できる。

### Terraform 管理外のもの

インフラは `terraform/` に寄せてあるが、以下は意図的に管理外にしている。

| 対象 | 作り方 | 管理外にする理由 |
| --- | --- | --- |
| tfstate バケット | `bootstrap.sh` | Terraform 管理下に置くと `destroy` で state の置き場ごと消える |
| Artifact Registry | `bootstrap.sh` | Cloud Run はイメージが無いと作成に失敗する。apply より前に build できる必要がある（`data` で参照） |
| Secret の値（version） | `gcloud secrets versions add` | `google_secret_manager_secret_version` を使うと**平文が state に残る**。入れ物だけ管理する |
| GCP プロジェクト・課金の紐付け | コンソール | プロジェクトが無いと provider が動かない |
| コンテナイメージ | `build.sh` | ビルドは Cloud Build。Terraform はタグを受け取るだけ |
| LINE の設定 | 手作業 | provider が存在せず、チャネル作成の公開 API も無い |

**イメージのタグは固定値にしない。** `:latest` のままだとタグ文字列が変わらず、
`terraform apply` が「変更なし」と判断して新しいイメージが反映されない。
`build.sh` が git のコミットハッシュでタグを打ち、`image.auto.tfvars` に
書き出す（`*.auto.tfvars` は Terraform が自動で読む）。

## 運用

### コードを変えて反映する

```bash
bun run deploy
```

イメージのタグが更新されるので、apply は 1 回で反映される。

### 手動でポーリングする

```bash
gcloud run jobs execute "$(terraform -chdir=terraform output -raw poll_job)" --region asia-northeast1
```

### ログを見る

```bash
gcloud run jobs executions list --job "$(terraform -chdir=terraform output -raw poll_job)" --region asia-northeast1
```

### ローカルで動かす

`.env` に認証情報を入れると `STATE_BUCKET` 無しでローカルの `.state` を使う。

```bash
cp .env.example .env
bun run poll
RESERVE_DRY_RUN=1 RESERVE_SLOT="2026-08-08 第1面 9:00～11:00" bun run reserve
```

### コスト

ポーリング 1 回は実測 9〜11 秒。月 2,880 回でも Cloud Run の無料枠
（180,000 vCPU 秒 / 360,000 GiB 秒）の 2 割程度に収まる。
仮に無料枠が無くても月 1 ドル未満。

`min_instance_count = 0` と `cpu_idle = true` により、webhook は
呼ばれていない間コンテナが起動せず課金されない。

## 注意事項

- 本ツールは個人利用を想定したものです。対象は公共の予約システムのため、
  システムに負荷をかけない節度ある利用（アクセス間隔の確保・必要最小限のリクエスト）を徹底してください
- クライアントはリクエスト間に待機時間（デフォルト 1.5 秒）を挟みます。短縮は推奨しません
- `fixtures/` 内の HTML は実サイトから取得後、利用団体名を匿名化し CSRF トークンをダミー値に置換したものです
