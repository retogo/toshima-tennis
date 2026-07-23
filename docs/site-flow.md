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
ログイン画面（`Home/WgR_Login`）を経て予約確認に進む（要・利用者番号）。

## 実装上の注意

- User-Agent はブラウザ相当の文字列を固定で送る
- リダイレクト追従（curl の `-L` 相当）を必ず有効にする。
  StartPage の `?CookieCheck=true` を踏み損ねるとトークンが取れず全 POST が失敗する
- 公共システムのためポーリング間隔は控えめに（連続アクセスの間に数秒の間隔を入れる）
