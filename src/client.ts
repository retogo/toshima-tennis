import {
  extractToken,
  parseDailyAvailability,
  parseTimeSlots,
  type DailyAvailability,
  type TimeSlot,
} from "./parser";

export const BASE_URL = "https://www2.pf489.com/toshima/WebR";
export const SPORTS_CATEGORY = "20";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

interface ClientOptions {
  fetchFn?: typeof fetch;
  delayMs?: number;
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

  async selectFacility(facilityCode: string): Promise<DailyAvailability[]> {
    const html = await this.postBack(
      `${BASE_URL}/Yoyaku/WgR_ShisetsuKensaku`,
      "next",
      "",
      [
        ["checkShisetsu", facilityCode],
        ["HyojiMode", "filterAll"],
      ],
    );
    return parseDailyAvailability(html);
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
