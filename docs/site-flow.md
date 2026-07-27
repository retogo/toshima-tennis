# 豊島区公共施設予約システム リクエストフロー解析

2026-07-23 時点、curl による実地調査の結果。

## 基本プロトコル

- ベース URL: `https://www2.pf489.com/toshima/WebR/`（パスの `toshima` は大文字小文字どちらでも可）
- ASP.NET MVC 2.0。セッションは `ASP.NET_SessionId` cookie（`Secure` / `HttpOnly`）で管理
- 全画面が単一フォームの POST 遷移。`__doPostBack(target, argument)` 相当で
  `__EVENTTARGET` / `__EVENTARGUMENT` を hidden に詰めて submit する
- 各画面に CSRF トークン `__RequestVerificationToken`（hidden input）があり、
  **直前の GET/POST レスポンスから毎回取り直して** 次の POST に含める必要がある
- トークン不正・セッション不整合時は「処理を続行できません（途中で放置…）」画面が返る

## 空き照会フロー（ログイン不要）

### 1. セッション確立

```
GET /Toshima/WebR/Home/StartPage/
→ 302 ?CookieCheck=true（cookie 確認用リダイレクト。必ず追従する）
→ 200 StartPage（検索フォーム + トークン）
```

### 2. カテゴリー検索（スポーツ施設）

```
POST /toshima/WebR/Home/WgR_ModeSelect
  __RequestVerificationToken=<StartPage のトークン>
  __EVENTTARGET=ssCategory
  __EVENTARGUMENT=20        ← スポーツ施設
→ 200 施設検索（Yoyaku/WgR_ShisetsuKensaku がフォーム action になる）
```

### 3. 施設選択

```
POST /toshima/WebR/Yoyaku/WgR_ShisetsuKensaku
  __RequestVerificationToken=<前画面のトークン>
  __EVENTTARGET=next
  checkShisetsu=116005      ← 施設コード（複数指定可）
  HyojiMode=filterAll
→ 200 施設別空き状況（日別の ○△×－/休場 マトリクス）
```

施設コード一覧（カテゴリー 20）:

| コード | 施設名                                     |
| ------ | ------------------------------------------ |
| 116001 | 豊島体育館                                 |
| 116002 | 巣鴨体育館                                 |
| 116003 | 雑司が谷体育館                             |
| 116004 | 池袋スポーツセンター                       |
| 116005 | 総合体育場（庭球場あり・室場コード 00502） |
| 116006 | 西巣鴨体育場                               |
| 116007 | 荒川野球場                                 |
| 116008 | 三芳グランド                               |
| 116009 | 南長崎スポーツセンター                     |
| 116086 | 千早スポーツフィールド                     |

### 3.5. 表示期間の変更（重要）

施設別空き状況の既定は **2 週間表示**で、土日が 4 日しか入らない。
予約可能な土日を取りこぼすため、期間を広げてから読む。

```
POST /toshima/WebR/Yoyaku/WgR_ShisetsubetsuAkiJoukyou
  __EVENTTARGET=hyouji        ← 画面の「表示」ボタン
  textDate=2026/7/27          ← 直前の画面の値をそのまま使う
  radioPeriod=1ヶ月            ← 1週間 / 2週間 / 1ヶ月
  radioJikan=all
  radioDisplay=false
  spinnerStayDays=0
  HyojiMode=filterAll
```

**3. の施設選択 POST に `radioPeriod` を混ぜても効かない。** 別途この
postback が要る。

`__EVENTTARGET=period` は期間の変更ではなく**前後のページ送り**で、
`__EVENTARGUMENT` に `prev` / `next` を取る。引数なしで投げると過去方向へ
動くので取り違えないこと。

実測（2026-07-27 時点）:

| radioPeriod | 日数 | 土日 |
| --- | --- | --- |
| 2週間（既定） | 13 | 4 |
| 1ヶ月 | 30 | 8 |

### 4. 日付選択 → 時間帯別空き状況

```
POST /toshima/WebR/Yoyaku/WgR_ShisetsubetsuAkiJoukyou
  __RequestVerificationToken=<前画面のトークン>
  __EVENTTARGET=next
  checkdate=<YYYYMMDD><室場コード5桁>   0   ← 例: "2026073000502   0"（空白3つ + 0）
  textDate=2026/7/23        ← 表示開始日
  radioPeriod=2週間          ← 1週間 / 2週間 / 1ヶ月
  radioJikan=all            ← am / pm / nt / all
  radioDisplay=false
  staydate=
  hyoujiOpenCloseFlg=close
→ 200 時間帯別空き状況
```

日別マトリクスの記号: `△`=一部空き、`×`=空きなし、`－`=対象外、`休場`。
`checkdate` は複数日指定可。

### 5. コマ（時間帯）選択

時間帯別空き状況画面では **空きコマのみ** checkbox として出現する:

```
<input type="checkbox" name="checktime"
       value="00502202607300211:00～13:00">
       ← 室場コード5桁 + YYYYMMDD + 面番号2桁 + 時間帯文字列
```

ここで `__EVENTTARGET=next` + `checktime=<コマ>` を
`/toshima/WebR/Yoyaku/WgR_JikantaibetsuAkiJoukyou` に POST すると
ログイン画面（`Home/WgR_Login`）に遷移する。

## 予約フロー（ログイン必要）

2026-07-27 時点。**ログイン画面までは実地確認済み、それ以降は未解析。**

### 6. ログイン

`Home/WgR_Login` は直接 GET できない（`Error/html/GoBackError.html` に飛ばされる）。
必ず 5. のコマ選択から遷移すること。

```
POST /toshima/WebR/Home/WgR_Login
  __RequestVerificationToken=<ログイン画面のトークン>
  __EVENTTARGET=nextlogin
  txtUserID=<利用者番号>      ← maxlength 16
  txtPassWord=<パスワード>    ← maxlength 16
```

- 画面上のソフトキーボード（`btn0`〜`btnZ`）は JS で入力欄を埋めるだけなので、
  HTTP クライアントからは `txtUserID` / `txtPassWord` を直接送れば足りる
- `__EVENTTARGET` の候補は `nextlogin`（ログイン実行）/ `idpass`（パスワード設定）/
  `lost_pswd`（パスワード忘れ）/ `prev`（戻る）/ `menu`
- **認証失敗時も HTTP 200 でログイン画面が返る。**成否は応答に `name="txtUserID"` が
  残っているかで判定する（`ToshimaClient#login` の実装）

### 7. 詳細申請

ログインに成功すると詳細申請画面（`Yoyaku/WgR_ShousaiShinsei`）に遷移する。
画面上部のパンくずは

```
施設の検索 → 施設別空き状況 → 時間帯別空き状況 → 詳細申請 → 申込確認 → 申込完了
```

で、選択したコマ（施設・利用日・時間帯）が確定済みの情報として表示される。
入力項目は 3 つですべて必須:

| name            | 種別   | 内容                                        |
| --------------- | ------ | ------------------------------------------- |
| `spinnerNinzu`  | number | 利用人数                                    |
| `radioMokuteki` | radio  | 使用目的。`404`=テニス / `405`=ソフトテニス |
| `txtYykShousai` | text   | 申請項目（行事名称）                        |

```
POST /toshima/WebR/Yoyaku/WgR_ShousaiShinsei
  __RequestVerificationToken=<詳細申請画面のトークン>
  __EVENTTARGET=next          ← 「確定」ボタン
  spinnerNinzu=<利用人数>
  radioMokuteki=404
  txtYykShousai=<行事名称>
```

この画面の postback ターゲットは `next`（確定）/ `back`（前に戻る）/
`history` / `menu` / `message` / `color` / `logout`。

`id=btnConfirm`（「はい」/「いいえ」）はログアウト確認ダイアログのもので、
予約の確定とは無関係。混同しないこと。

### 8. 申込確認 → 申込完了（未解析）

パンくずから、詳細申請の後に **申込確認** と **申込完了** の 2 画面が続く。
この 2 画面は実際に予約を成立させないと到達できないため未調査。

**注意**: ここから先は取り消しに施設規定（期限・手数料）が伴う。

## 実装上の注意

- User-Agent はブラウザ相当の文字列を固定で送る
- リダイレクト追従（curl の `-L` 相当）を必ず有効にする。
  StartPage の `?CookieCheck=true` を踏み損ねるとトークンが取れず全 POST が失敗する
- 公共システムのためポーリング間隔は控えめに（連続アクセスの間に数秒の間隔を入れる）
