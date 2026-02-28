import { log, logUpstreamCall, recordUpstreamStats } from "../logger.js";

const ARES_BASE_URL = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest";

// Simple rate limiter: max 400 req/min to stay safely under 500/min ARES limit
let requestTimestamps: number[] = [];
const MAX_REQUESTS_PER_MINUTE = 400;

async function rateLimitedFetch(
  url: string,
  options?: RequestInit
): Promise<Response> {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter((t) => now - t < 60_000);

  if (requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
    const waitMs = 60_000 - (now - requestTimestamps[0]);
    log.warn("ares_rate_limit_wait", { waitMs });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  requestTimestamps.push(Date.now());

  const start = performance.now();
  const response = await fetch(url, options);
  const durationMs = Math.round(performance.now() - start);

  logUpstreamCall({
    api: "ARES",
    method: options?.method || "GET",
    url,
    status: response.status,
    durationMs,
    cached: false,
  });
  recordUpstreamStats("ARES", durationMs, response.ok);

  return response;
}

export interface AresSearchParams {
  obchodniJmeno?: string;
  ico?: string[];
  sidlo?: {
    textovaAdresa?: string;
    kodObce?: number;
    kodUlice?: number;
  };
  pravniForma?: string[];
  czNace?: string[];
  start?: number;
  pocet?: number;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`ARES API error (${response.status}): ${errorText}`);
  }
  return response.json() as Promise<T>;
}

export async function searchCompanies(params: AresSearchParams): Promise<any> {
  const body: Record<string, any> = {};
  if (params.obchodniJmeno) body.obchodniJmeno = params.obchodniJmeno;
  if (params.ico) body.ico = params.ico;
  if (params.sidlo) body.sidlo = params.sidlo;
  if (params.pravniForma) body.pravniForma = params.pravniForma;
  if (params.czNace) body.czNace = params.czNace;
  body.start = params.start ?? 0;
  body.pocet = params.pocet ?? 10;

  const response = await rateLimitedFetch(
    `${ARES_BASE_URL}/ekonomicke-subjekty/vyhledat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  return handleResponse(response);
}

export async function getCompanyByIco(ico: string): Promise<any> {
  const response = await rateLimitedFetch(
    `${ARES_BASE_URL}/ekonomicke-subjekty/${ico}`
  );
  return handleResponse(response);
}

export async function getCompanyVr(ico: string): Promise<any> {
  const response = await rateLimitedFetch(
    `${ARES_BASE_URL}/ekonomicke-subjekty-vr/${ico}`
  );
  const data = await handleResponse<any>(response);
  // VR wraps records in zaznamy array — unwrap the primary record
  const record = Array.isArray(data.zaznamy)
    ? data.zaznamy.find((r: any) => r.primarniZaznam) ?? data.zaznamy[0]
    : data;
  return record;
}

export async function getCompanyRzp(ico: string): Promise<any> {
  const response = await rateLimitedFetch(
    `${ARES_BASE_URL}/ekonomicke-subjekty-rzp/${ico}`
  );
  const data = await handleResponse<any>(response);
  // RZP wraps records in zaznamy array — unwrap the primary record
  const record = Array.isArray(data.zaznamy)
    ? data.zaznamy.find((r: any) => r.primarniZaznam) ?? data.zaznamy[0]
    : data;
  return record;
}

export async function getCompanyCeu(ico: string): Promise<any> {
  const response = await rateLimitedFetch(
    `${ARES_BASE_URL}/ekonomicke-subjekty-ceu/${ico}`
  );
  const data = await handleResponse<any>(response);
  // CEU wraps records in zaznamy array — unwrap the primary record
  const record = Array.isArray(data.zaznamy)
    ? data.zaznamy.find((r: any) => r.primarniZaznam) ?? data.zaznamy[0]
    : data;
  return record;
}

export async function searchStandardizedAddresses(
  params: Record<string, any>
): Promise<any> {
  const response = await rateLimitedFetch(
    `${ARES_BASE_URL}/standardizovane-adresy/vyhledat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }
  );
  return handleResponse(response);
}
