import {
  extractInputValue,
  extractToken,
  parseDailyAvailability,
  parseTimeSlots,
  type DailyAvailability,
  type TimeSlot,
} from "./parser";

export const BASE_URL = "https://www2.pf489.com/toshima/WebR";
export const SPORTS_CATEGORY = "20";

/** 施設別空き状況画面の表示期間（radioPeriod）。 */
export type DisplayPeriod = "1週間" | "2週間" | "1ヶ月";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

interface ClientOptions {
  fetchFn?: typeof fetch;
  delayMs?: number;
}

/** 詳細申請画面の使用目的（radioMokuteki）。 */
export const MOKUTEKI = {
  tennis: "404",
  softTennis: "405",
} as const;

export type Mokuteki = (typeof MOKUTEKI)[keyof typeof MOKUTEKI];

/** 詳細申請画面の必須入力。 */
export interface ApplicationDetails {
  /** 利用人数（spinnerNinzu） */
  ninzu: number;
  /** 使用目的（radioMokuteki） */
  mokuteki: Mokuteki;
  /** 申請項目＝行事名称（txtYykShousai） */
  gyoujiMeishou: string;
}

export class ToshimaClient {
  token = "";
  private cookies = new Map<string, string>();
  private lastUrl = "";
  private readonly fetchFn: typeof fetch;
  private readonly delayMs: number;

  constructor(options: ClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.delayMs = options.delayMs ?? 1500;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    if (this.cookies.size > 0) {
      headers["Cookie"] = [...this.cookies.entries()]
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    }
    if (this.lastUrl) headers["Referer"] = this.lastUrl;
    return headers;
  }

  private storeCookies(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const eq = pair!.indexOf("=");
      this.cookies.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim());
    }
  }

  private async request(url: string, init: RequestInit): Promise<string> {
    let currentUrl = url;
    let currentInit = init;
    for (;;) {
      const response = await this.fetchFn(currentUrl, {
        ...currentInit,
        headers: { ...this.headers(), ...currentInit.headers },
        redirect: "manual",
      });
      this.storeCookies(response);
      if (response.status >= 300 && response.status < 400) {
        currentUrl = new URL(
          response.headers.get("location")!,
          currentUrl,
        ).toString();
        currentInit = { method: "GET" };
        continue;
      }
      const html = await response.text();
      this.lastUrl = currentUrl;
      this.token = extractToken(html);
      return html;
    }
  }

  async get(url: string): Promise<string> {
    return this.request(url, { method: "GET" });
  }

  async postBack(
    url: string,
    eventTarget: string,
    eventArgument = "",
    extraFields: [string, string][] = [],
  ): Promise<string> {
    await Bun.sleep(this.delayMs);
    const params = new URLSearchParams([
      ["__RequestVerificationToken", this.token],
      ["__EVENTTARGET", eventTarget],
      ["__EVENTARGUMENT", eventArgument],
      ...extraFields,
    ]);
    return this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  }

  async openStartPage(): Promise<string> {
    return this.get(`${BASE_URL}/Home/StartPage/`);
  }

  async openSportsCategory(): Promise<string> {
    return this.postBack(
      `${BASE_URL}/Home/WgR_ModeSelect`,
      "ssCategory",
      SPORTS_CATEGORY,
    );
  }

  /**
   * 施設を選び、日別の空き状況を取得する。
   *
   * 画面の既定は 2 週間表示で、土日が 4 日しか入らない。予約可能な土日を
   * 取りこぼすため、「表示」ボタン相当（__EVENTTARGET=hyouji）で期間を
   * 広げてから読む。施設選択の POST に radioPeriod を混ぜても効かない。
   *
   * 基準日（textDate）は画面に出ている値をそのまま使う。Cloud Run は UTC で
   * 動くため、自前で「今日」を組み立てると JST とずれる日が出る。
   */
  async selectFacility(
    facilityCode: string,
    period: DisplayPeriod = "1ヶ月",
  ): Promise<DailyAvailability[]> {
    const selected = await this.postBack(
      `${BASE_URL}/Yoyaku/WgR_ShisetsuKensaku`,
      "next",
      "",
      [
        ["checkShisetsu", facilityCode],
        ["HyojiMode", "filterAll"],
      ],
    );

    const html = await this.postBack(
      `${BASE_URL}/Yoyaku/WgR_ShisetsubetsuAkiJoukyou`,
      "hyouji",
      "",
      [
        ["textDate", extractInputValue(selected, "textDate")],
        ["radioPeriod", period],
        ["radioJikan", "all"],
        ["radioDisplay", "false"],
        ["spinnerStayDays", "0"],
        ["HyojiMode", "filterAll"],
      ],
    );
    return parseDailyAvailability(html);
  }

  /**
   * ログイン画面（コマ選択後に遷移する）で利用者番号とパスワードを送る。
   *
   * 認証失敗時もサイトは 200 でログイン画面を返すため、応答に利用者番号の
   * 入力欄が残っているかどうかで成否を判定する。
   * 例外メッセージには認証情報を載せない（CI のログに残るため）。
   */
  async login(userId: string, password: string): Promise<string> {
    const html = await this.postBack(
      `${BASE_URL}/Home/WgR_Login`,
      "nextlogin",
      "",
      [
        ["txtUserID", userId],
        ["txtPassWord", password],
      ],
    );
    if (html.includes('name="txtUserID"')) {
      throw new Error(
        "ログインに失敗しました（利用者番号またはパスワードを確認してください）",
      );
    }
    return html;
  }

  /**
   * 詳細申請画面（ログイン直後に遷移する）で必須項目を送り、申込確認へ進む。
   *
   * 入力不備などで進めなかった場合もサイトは 200 で詳細申請画面を返すため、
   * 応答に入力欄が残っているかどうかで判定する。
   */
  async submitApplication(details: ApplicationDetails): Promise<string> {
    const html = await this.postBack(
      `${BASE_URL}/Yoyaku/WgR_ShousaiShinsei`,
      "next",
      "",
      [
        ["spinnerNinzu", String(details.ninzu)],
        ["radioMokuteki", details.mokuteki],
        ["txtYykShousai", details.gyoujiMeishou],
      ],
    );
    if (html.includes('name="spinnerNinzu"')) {
      throw new Error(
        "詳細申請を送信しましたが画面が進みませんでした（入力内容を確認してください）",
      );
    }
    return html;
  }

  /**
   * 申込確認画面で「申込」を押し、予約を確定させる。
   *
   * **不可逆な操作。** 呼ぶ前に必ず verifyConfirmation で画面の内容が
   * 意図したコマと一致していることを確かめること。
   */
  async confirmReservation(): Promise<string> {
    const html = await this.postBack(
      `${BASE_URL}/Yoyaku/WgR_YoyakuKakunin`,
      "next",
    );
    if (html.includes("__doPostBack('next','')")) {
      throw new Error(
        "確定を送信しましたが申込確認画面のままです（予約が成立したか予約システムで確認してください）",
      );
    }
    return html;
  }

  async openTimeSlots(checkdateValues: string[]): Promise<TimeSlot[]> {
    const html = await this.postBack(
      `${BASE_URL}/Yoyaku/WgR_ShisetsubetsuAkiJoukyou`,
      "next",
      "",
      checkdateValues.map((v) => ["checkdate", v] as [string, string]),
    );
    return parseTimeSlots(html);
  }
}
