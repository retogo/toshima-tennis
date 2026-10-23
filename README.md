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
bun run cancel        # 1 コマを取消（CANCEL_SLOT で指定）
bun run cancel:due    # 未承認のまま期限が近い予約を取消
bun run probe:cancel  # 予約確認・取消フローの画面構造を調査
bun run probe         # 予約フローの画面構造を調査
bun run notify:test   # LINE への疎通確認

bun test              # テスト
bun run typecheck     # 型検査
```

デプロイは GitHub Actions が行う（「デプロイ」参照）。

## 構成

GitHub には依存しない。すべて GCP 上で動く。

```
Cloud Scheduler (JST 06:00-02:00 / 10分間隔)
  → Cloud Run Job: poll
       空き状況を確認 → GCS の状態と比較 → 変化があれば LINE に通知
       approve モードなら候補をボタン付きで送る

LINE のボタンをタップ
  → Cloud Run Service: webhook
       X-Line-Signature を検証 / 送信者 userId を照合
  → 予約: Cloud Run Job reserve  空き状況を取り直し → 確定前照合 → 予約
     取消: Cloud Run Job cancel  予約一覧を取り直し → 確定前照合 → 取消
     承認: 記録を承認済みにするだけ（予約システムに触らない）

Cloud Scheduler (JST 12:00 / 日次)
  → Cloud Run Job: cancel-due
       承認されないまま取消期限が近い予約を取り消す
```

| 要素 | 役割 |
| --- | --- |
| `scripts/poll.ts` | ポーリングと通知（Job） |
| `scripts/reserve-one.ts` | 1 コマの予約（Job） |
| `scripts/cancel-one.ts` | 1 コマの取消（Job） |
| `scripts/cancel-due.ts` | 未承認予約の自動取消（Job・日次） |
| `server/index.ts` | LINE webhook（Service） |
| GCS `<project>-state` | 前回の空き状況・自動予約の承認状態 |
| Secret Manager | LINE と予約システムの認証情報 |

### 通知の絞り込み

空きが続く限り通知が飛ばないよう、空きコマ一覧を署名文字列に正規化して
前回と比較し、**変化したエッジでのみ**通知する（`src/notify.ts`）。

さらに、**署名は希望条件（`reserve.json` の `wishes`）に一致するコマだけ**で作る。
全コマで作ると、興味のない曜日・時間帯の増減でも通知が鳴ってしまうため
（実測で空き 13 件がすべて平日、希望条件の土日は 0 件という状態が起きていた）。
判定は `src/notifiable.ts`。

`approve` モードのボタン付き通知（`pending`）も同じエッジ検知に乗る。候補が
残っている間はポーリングのたびに送らず、候補の内容が変わったときだけ送る。
予約成立の通知（`reserved`）だけは例外で、変化にかかわらず必ず送る。

候補が 0 件に落ちたときは「なくなりました」を 1 通送る（`gone`）。**LINE には
送信済みメッセージを編集する API が無い**ため、先に送ったボタン付き通知を
無効化する手段が新しい通知しかない。0 件が続く間は黙る。

### 権限の分離

webhook は公開エンドポイントなので、**予約システムの認証情報を持たせない**。
Job を起動するだけで、利用者番号もパスワードも知らない。起動時に環境変数も
上書きさせず、対象のコマは state に置いた依頼で渡す。

**公式アカウントは誰でも友だち追加できる。**署名検証だけでは第三者が予約を
叩けるため、送信者 userId の照合は外せない。

## 動作モード

`reserve.json` の `mode` で自動化の度合いを変える。**LINE からも切り替えられる**
（後述）。LINE で切り替えた値は GCS の `mode.txt` に残り、`reserve.json` より優先される。

| mode | 挙動 |
| --- | --- |
| `approve` | 候補をボタン付きで通知し、押されたら予約（既定） |
| `auto` | 条件に一致したらその場で予約確定 |

以前あった `notify`（通知だけでボタンを出さない）は廃止した。`approve` との違いが
ボタンの有無しかなく、通知に出るコマも同じで、モードとして分ける意味が無かった。

### 承認しないと取り消される（auto モード）

`auto` は予約したあと「承認 / 取消」ボタン付きで通知する。**承認しないまま
取消期限（使用日の 1 週間前・同一曜日）の `cancelBufferDays` 日前になると
自動で取り消す。** 承認すれば以後その予約は自動取消の対象から外れる。

| 操作 | 起きること |
| --- | --- |
| 承認を押す | 記録が承認済みになる。予約はそのまま残る |
| 取消を押す | その場で取消 Job が動く |
| 何もしない | 期限の `cancelBufferDays` 日前に自動で取り消される |

**期限当日には取り消さない。** ジョブが失敗したときに期限を超過すると、窓口・
電話でのキャンセル料が発生する。既定の 2 日前なら 1 日空振りしても翌日やり直せる。

**記録に無い予約は絶対に取り消さない**（`src/tracked.ts`）。自分で予約システムから
取った予約をツールが勝手に消してしまう事故を防ぐため。承認の対象にもならない。

**取消可否はサイトに聞く。** 取消期限を過ぎた予約にはサイトが取消のチェック
ボックスを出さないので、期限を自前で計算して判断しない。

### 使用日が近いコマは自動予約しない

サイトは**使用日の 7 日前になるまで予約させない**（日別画面が `－` ＝申込期間外）。
一方で**取消期限も使用日の 7 日前**。両者が重なるため、予約できるようになった
直後のコマには承認の猶予がまったく無い。

| 使用日 | 取消期限 | 自動取消の開始 | 扱い |
| --- | --- | --- | --- |
| 今日+7（最短） | 今日 | 過去 | 自動予約しない |
| 今日+8〜+9 | 今日+1〜+2 | 過去 | 自動予約しない |
| 今日+10 以降 | 今日+3 以降 | 今日+1 以降 | 自動予約する |

最短のケースは取消期限が当日なので、日次ジョブが取り逃すと**二度と取り消せず
2,000 円が確定する**。そのため `auto` でも猶予が取れないコマは予約せず、
`approve` と同じ「予約」ボタン付きで通知して人に決めてもらう（本文で取り消せない
可能性を明記する）。判定は `hasApprovalWindow`（`src/tracked.ts`）。

`matchingSlots` は一番近い日を選ぶため、この帯は頻繁に現れる。

| 項目 | 内容 |
| --- | --- |
| `wishes[].daysOfWeek` | 0（日）〜6（土）。省略時は曜日を問わない |
| `wishes[].timeRanges` | `"9:00～11:00"` 形式。省略時は時間帯を問わない |
| `wishes[].courts` | 面番号。省略時は面を問わない |
| `maxPerRun` | 1 回の実行で予約する件数の上限 |
| `maxPerMonth` | 暦月あたりの予約件数の上限（サイトの予約一覧から数える） |
| `cancelBufferDays` | 承認されない予約を取消期限の何日前に取り消すか（既定 2） |
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

## LINE からの操作

**チャット下部のリッチメニューから操作する。** 「メニュー」のバーを開くと 3 つの
ボタンが出る。押すと用語が送信されるので、何を操作したかが会話に残る。

| ボタン | 送信される用語 |
| --- | --- |
| 予約状況 | `状況` |
| 自動で予約 | `自動` |
| 押したら予約 | `手動` |
| 希望条件 | `条件` |

### LINE から変えられる設定

| 項目 | 選べる値 |
| --- | --- |
| 動作モード | `approve` / `auto` |
| 月の上限 | 1〜4 件（そのまま支出の上限。1 件 2,000 円） |
| 希望する曜日 | 日〜土をそれぞれ入切 |
| 希望する時間帯 | サイトの 6 枠をそれぞれ入切 |

上書きは GCS の `settings.json` に入り、**`reserve.json` より優先される**。
`reserve.json` を書き換えても上書きが残っていれば効かないので、挙動が設定と
合わないときはまず `gs://<project>-state/settings.json` を見る。

**曜日を全部外すと何も予約しなくなる。** 曜日を省略した状態（＝全曜日が対象）とは
別で、「空の集合」は何にも一致しない。画面でもそう表示する。時間帯は空＝指定なしで
全枠が対象。

**LINE から編集できるのは「曜日の集合 × 時間帯の集合」1 組だけ。** `reserve.json` に
複数の希望条件を書いていた場合、LINE で編集するとこの 1 組に置き換わる。

**リッチメニューは PC 版 LINE（macOS / Windows）では表示されない。** モバイル限定。
PC からは用語を直接打てば同じことができる。

### リッチメニューの作り直し

リッチメニューは「メニューの絵が描かれた画像 1 枚」＋「その上に重ねる透明なタップ
領域」という作りで、**文字だけのリッチメニューは作れない**。見た目は
`scripts/richmenu.html` に描き、ヘッドレス Chrome で PNG にしている。画面の解像度に
縛られず指定 px で出力するためにヘッドレスを使う。

```bash
bun run richmenu           # 画像を作って定義を検証するだけ（登録しない）
bun run richmenu --upload  # 作成・画像アップロードまで（まだ表示されない）
bun run richmenu --apply   # 既定として適用（ここで見えるようになる）
```

画像のサイズ制約（`richmenu/validate` で実測）:

| 項目 | 値 |
| --- | --- |
| 幅 | 800〜2500 px |
| 高さ | 250 px 以上 |
| 縦横比 | 幅 ÷ 高さ ≥ 1.45 |
| タップ領域 | 最大 20 |
| 形式 | JPEG / PNG の 1 枚 |

**列の分割は `richmenu.html` の `grid-template-columns` と `richmenu.ts` の
タップ領域で揃える。** ずれると見えているボタンと押した結果が食い違う。

やめるときは既定の割り当てを外す。

```bash
curl -X DELETE https://api.line.me/v2/bot/user/all/richmenu \
  -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN"
```

**用語を直接送っても反応する。** メニューのボタンは postback ではなく用語を送信するので、
何を操作したかが会話に残る。**用語以外のテキストには何も返さない。**

| 用語 | 内容 |
| --- | --- |
| `メニュー` | 操作メニューを出す |
| `状況` | 予約一覧・使用料・取消期限・承認状態を出す。取消できる予約には取消ボタンを付ける |
| `自動` | `auto` に切り替える |
| `手動` | `approve` に切り替える |

**予約と取消はテキストでは動かない。** 不可逆な操作を誤送信や転送で走らせないため、
コマを指定する操作は postback のボタンだけにしてある。

応答（reply）は無料枠を消費しないので、メニューと状況表示は何度使っても通数が増えない。

吹き出しは `size: "giga"`（最大幅）にしてある。既定の `mega` では折り返しが多く読みにくい。
モードは 2 つなので、メニューは**今のモードを文で出し、もう片方に変えるボタンを 1 つ**
置く形にしている（選択中を装飾で示すと分かりにくい）。

予約一覧は **poll が GCS に置いたスナップショット**を読む。webhook は予約システムの
認証情報を持たない設計なので、自分で取りに行かない。最大 1 時間古くなるが、取消期限の
判定は日付単位なので実害がない（`auto` では毎回更新される）。

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

GCP 側の構成（Cloud Run サービス・Job・Scheduler・Secret の入れ物・権限）は
retogo/infra の `apps/toshima-tennis`（GCP プロジェクト `retogo-prod`）で管理している。
このリポジトリが受け持つのはコンテナイメージの更新だけ。

main にイメージに関わる変更（`src/` `server/` `scripts/` `reserve.json` など）が入ると、
`.github/workflows/deploy.yml` がテスト・型検査の後にイメージをビルドして push し、
webhook を `gcloud run deploy`、4 つの Job を `gcloud run jobs update` で差し替える。
タグはコミットハッシュ。手動で出し直すときは:

```bash
gh workflow run deploy.yml
```

認証は Workload Identity Federation。リポジトリ変数 `WIF_PROVIDER` /
`DEPLOY_SERVICE_ACCOUNT` を使う（値は retogo/infra の output）。

### シークレットの値を入れる

**値は Terraform で管理しない**（state に平文が残るため）。入れ物は retogo/infra が作る。

```bash
printf '%s' '<チャネルアクセストークン>' | gcloud secrets versions add toshima-tennis-line-channel-access-token --data-file=- --project=retogo-prod
printf '%s' '<チャネルシークレット>'     | gcloud secrets versions add toshima-tennis-line-channel-secret --data-file=- --project=retogo-prod
printf '%s' '<ユーザーID>'               | gcloud secrets versions add toshima-tennis-line-to --data-file=- --project=retogo-prod
printf '%s' '<利用者番号>'               | gcloud secrets versions add toshima-tennis-user-id --data-file=- --project=retogo-prod
printf '%s' '<パスワード>'               | gcloud secrets versions add toshima-tennis-password --data-file=- --project=retogo-prod
```

### Webhook URL を登録する

retogo/infra の `terraform output webhook_url` を Developers コンソールの
「Messaging API設定 → Webhook URL」に設定し、「Webhookの利用」をオンにする。
「検証」ボタンで疎通を確認できる。LINE の設定は provider が存在せず、チャネル作成の
公開 API も無いため手作業になる。

## 運用

### コードを変えて反映する

main に入れると deploy.yml が反映する。

### 手動でポーリングする

```bash
gcloud run jobs execute toshima-poll --region asia-northeast1 --project retogo-prod
```

### ログを見る

```bash
gcloud run jobs executions list --job toshima-poll --region asia-northeast1 --project retogo-prod
```

### ローカルで動かす

`.env` に認証情報を入れると `STATE_BUCKET` 無しでローカルの `.state` を使う。

```bash
cp .env.example .env
bun run poll
RESERVE_DRY_RUN=1 RESERVE_SLOT="2026-08-08 第1面 9:00～11:00" bun run reserve
```

### コスト

ポーリング 1 回は実測 9〜11 秒。月 3,600 回でも Cloud Run の無料枠
（180,000 vCPU 秒 / 360,000 GiB 秒）の 1/4 程度に収まる。
仮に無料枠が無くても月 1 ドル未満。

`min_instance_count = 0` と `cpu_idle = true` により、webhook は
呼ばれていない間コンテナが起動せず課金されない。

## 注意事項

- 本ツールは個人利用を想定したものです。対象は公共の予約システムのため、
  システムに負荷をかけない節度ある利用（アクセス間隔の確保・必要最小限のリクエスト）を徹底してください
- クライアントはリクエスト間に待機時間（デフォルト 1.5 秒）を挟みます。短縮は推奨しません
- `fixtures/` 内の HTML は実サイトから取得後、利用団体名を匿名化し CSRF トークンをダミー値に置換したものです
