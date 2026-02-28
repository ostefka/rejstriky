import { Router } from "express";
import { log } from "../logger.js";
import {
  searchCompanies,
  getCompanyByIco,
  getCompanyVr,
  getCompanyRzp,
  getCompanyCeu,
  searchStandardizedAddresses,
} from "../ares/client.js";
import {
  resolveLegalForm,
  resolveNace,
  formatAddress,
  formatDate,
  resolveRegistryStatus,
} from "../formatters/czech.js";

const router = Router();
const ICO_REGEX = /^\d{1,8}$/;

// GET /api/search - Search companies
router.get("/search", async (req, res) => {
  try {
    const { name, ico, city, street, maxResults } = req.query;

    if (!name && !ico && !city && !street) {
      res.status(400).json({ error: "Provide at least one: name, ico, city, or street" });
      return;
    }

    const params: any = {};
    if (name) params.obchodniJmeno = String(name);
    if (ico) params.ico = [String(ico)];
    if (city || street) {
      params.sidlo = {} as any;
      if (city) params.sidlo.nazevObce = String(city);
      if (street) params.sidlo.nazevUlice = String(street);
    }
    params.pocet = maxResults ? Math.min(parseInt(String(maxResults), 10) || 10, 100) : 10;

    const data = await searchCompanies(params);
    const companies = (data.ekonomickeSubjekty || []).map((c: any) => ({
      name: c.obchodniJmeno || null,
      ico: c.ico || null,
      status: resolveRegistryStatus(c.stavSubjektu, c.datumZaniku),
      legalForm: resolveLegalForm(c.pravniForma),
      address: formatAddress(c.sidlo),
      founded: c.datumVzniku || null,
    }));

    res.json({ total: data.pocetCelkem ?? companies.length, companies });
  } catch (error: any) {
    log.error("api_search_error", { error: error.message });
    res.status(502).json({ error: "Failed to search companies" });
  }
});

// GET /api/company/:ico - Company detail
router.get("/company/:ico", async (req, res) => {
  if (!ICO_REGEX.test(req.params.ico)) {
    res.status(400).json({ error: "IČO must be 1-8 digits" });
    return;
  }
  try {
    const ico = req.params.ico.padStart(8, "0");
    const c = await getCompanyByIco(ico);

    const result: any = {
      name: c.obchodniJmeno || null,
      ico: c.ico,
      dic: c.dic || null,
      status: resolveRegistryStatus(c.stavSubjektu, c.datumZaniku),
      legalForm: resolveLegalForm(c.pravniForma),
      address: formatAddress(c.sidlo),
      founded: c.datumVzniku || null,
      lastUpdated: c.datumAktualizace || null,
      czNace: (c.czNace || []).map((code: string) => ({ code, description: resolveNace(code) })),
    };

    const regs: string[] = [];
    if (c.registpiOr) regs.push("Obchodní rejstřík (OR)");
    if (c.registpiRzp) regs.push("Živnostenský rejstřík (RŽP)");
    if (c.registpiNrpzs) regs.push("Národní registr poskytovatelů zdravotních služeb (NRPZS)");
    if (c.registpiRcns) regs.push("Rejstřík církví a náboženských společností (RCNS)");
    if (c.registpiSzr) regs.push("Registr zemědělských podnikatelů (SZR)");
    if (c.registpiIre) regs.push("Rejstřík škol a školských zařízení (IRE)");
    if (c.registpiCeu) regs.push("Centrální evidence úpadců (CEÚ)");
    result.registrations = regs;

    if (c.financniUrad) result.financialAuthority = c.financniUrad;

    res.json(result);
  } catch (error: any) {
    log.error("api_company_detail_error", { error: error.message });
    res.status(error.message?.includes("404") ? 404 : 502).json({ error: error.message?.includes("404") ? "Company not found" : "Failed to fetch company detail" });
  }
});

// Helper: VR stores many fields as arrays of {datumZapisu, hodnota, datumVymazu?}
// Return the latest non-deleted value.
function vrLatest(arr: any): string | null {
  if (!Array.isArray(arr)) return arr ?? null;
  const current = arr.find((e: any) => !e.datumVymazu);
  return (current ?? arr[0])?.hodnota ?? null;
}

// GET /api/company/:ico/officers - Company officers
router.get("/company/:ico/officers", async (req, res) => {
  if (!ICO_REGEX.test(req.params.ico)) {
    res.status(400).json({ error: "IČO must be 1-8 digits" });
    return;
  }
  try {
    const ico = req.params.ico.padStart(8, "0");
    const data = await getCompanyVr(ico);

    // VR obchodniJmeno is array of {datumZapisu, hodnota}
    const name = vrLatest(data.obchodniJmeno);

    // spisovaZnacka is array of {soud, oddil, vlozka}
    const czEntry = Array.isArray(data.spisovaZnacka) ? data.spisovaZnacka[0] : null;
    const courtFile = czEntry ? `${czEntry.oddil} ${czEntry.vlozka}, ${czEntry.soud}` : null;

    const result: any = {
      name,
      ico,
      courtFile,
      register: data.rejstrik || null,
    };

    // zakladniKapital is array — pick latest non-deleted
    if (Array.isArray(data.zakladniKapital) && data.zakladniKapital.length > 0) {
      const latest = data.zakladniKapital.find((k: any) => !k.datumVymazu) ?? data.zakladniKapital[0];
      const vklad = latest.vklad || {};
      result.registeredCapital = {
        amount: vklad.hodnota ?? null,
        currency: vklad.typObnos === "KORUNY" ? "CZK" : (vklad.typObnos ?? "CZK"),
      };
    }

    // statutarniOrgany is the correct field name
    const bodies = data.statutarniOrgany || [];
    result.statutoryBodies = Array.isArray(bodies)
      ? bodies.map((body: any) => {
          // zpusobJednani may be array of {datumZapisu, hodnota} or string
          let actingMethod: string | null = null;
          if (Array.isArray(body.zpusobJednani)) {
            actingMethod = vrLatest(body.zpusobJednani);
          } else if (typeof body.zpusobJednani === "string" && body.zpusobJednani.trim()) {
            actingMethod = body.zpusobJednani.trim();
          }

          return {
            name: body.nazevOrganu || "Statutární orgán",
            actingMethod,
            members: (body.clenoveOrganu || [])
              .filter((m: any) => !m.datumVymazu) // only current members
              .map((m: any) => {
                const person = m.fyzickaOsoba;
                if (person) {
                  return {
                    name: [person.jmeno, person.prijmeni].filter(Boolean).join(" ") || person.textOsoba || null,
                    dateOfBirth: person.datumNarozeni || null,
                    memberSince: m.datumZapisu || null,
                    inRoleSince: m.clenstvi?.funkce?.vznikFunkce || null,
                    role: m.clenstvi?.funkce?.nazev || m.nazevAngazma || null,
                    address: person.adresa?.textovaAdresa || null,
                  };
                }
                return null;
              }).filter(Boolean),
          };
        })
      : [];

    res.json(result);
  } catch (error: any) {
    log.error("api_officers_error", { error: error.message });
    res.status(error.message?.includes("404") ? 404 : 502).json({ error: error.message?.includes("404") ? "Company not found" : "Failed to fetch officers" });
  }
});

// GET /api/company/:ico/licenses - Trade licenses
router.get("/company/:ico/licenses", async (req, res) => {
  if (!ICO_REGEX.test(req.params.ico)) {
    res.status(400).json({ error: "IČO must be 1-8 digits" });
    return;
  }
  try {
    const ico = req.params.ico.padStart(8, "0");
    const data = await getCompanyRzp(ico);

    // RZP obchodniJmeno is a direct string
    // Address is in adresySubjektu — could be array or single object, fields are flat (not nested in .adresa)
    const addrEntries = Array.isArray(data.adresySubjektu) ? data.adresySubjektu : (data.adresySubjektu ? [data.adresySubjektu] : []);
    const addrEntry = addrEntries.find((a: any) => a.typAdresy === "SIDLO") ?? addrEntries[0] ?? null;

    const licenses = data.zivnosti || [];
    const activeLicenses = licenses.filter((l: any) => !l.datumZaniku);
    const result = {
      name: data.obchodniJmeno || null,
      ico,
      address: addrEntry?.textovaAdresa || (addrEntry ? formatAddress(addrEntry) : null),
      totalLicenses: licenses.length,
      activeLicenses: activeLicenses.length,
      licenses: licenses.map((l: any) => ({
        subject: l.predmetPodnikani || null,
        type: l.druhZivnosti || null,
        validFrom: l.datumVzniku || null,
        validTo: l.datumZaniku || null,
      })),
    };

    res.json(result);
  } catch (error: any) {
    log.error("api_licenses_error", { error: error.message });
    res.status(error.message?.includes("404") ? 404 : 502).json({ error: error.message?.includes("404") ? "Company not found" : "Failed to fetch licenses" });
  }
});

// GET /api/company/:ico/insolvency - Insolvency check
router.get("/company/:ico/insolvency", async (req, res) => {
  if (!ICO_REGEX.test(req.params.ico)) {
    res.status(400).json({ error: "IČO must be 1-8 digits" });
    return;
  }
  try {
    const ico = req.params.ico.padStart(8, "0");
    const data = await getCompanyCeu(ico);

    // CEU field names: evidenceUpadcu or insolvencniRizeni
    const records = data.evidenceUpadcu || data.insolvencniRizeni || [];
    const name = typeof data.obchodniJmeno === "string"
      ? data.obchodniJmeno
      : (Array.isArray(data.obchodniJmeno) ? data.obchodniJmeno[0]?.hodnota : null);

    res.json({
      name,
      ico,
      hasInsolvency: records.length > 0,
      records: records.map((r: any) => ({
        courtFile: r.spisovaZnacka || null,
        status: r.stav || null,
        started: r.datumZahajeni || null,
        ended: r.datumUkonceni || null,
        court: r.soud || null,
        type: r.druhRizeni || null,
      })),
    });
  } catch (error: any) {
    if (error.message?.includes("404")) {
      res.json({ ico: req.params.ico.padStart(8, "0"), hasInsolvency: false, records: [] });
      return;
    }
    log.error("api_insolvency_error", { error: error.message });
    res.status(502).json({ error: "Failed to check insolvency" });
  }
});

// GET /api/address/validate - Validate address
router.get("/address/validate", async (req, res) => {
  try {
    const { city, street, houseNumber, postalCode, maxResults } = req.query;

    if (!city) {
      res.status(400).json({ error: "city parameter is required" });
      return;
    }

    const body: Record<string, any> = {
      nazevObce: String(city),
      pocet: maxResults ? Math.min(parseInt(String(maxResults), 10) || 5, 50) : 5,
      typStandardizaceAdresy: "VYHOVUJICI_ADRESY",
    };
    if (street) body.nazevUlice = String(street);
    if (houseNumber) body.cisloDomovni = String(houseNumber);
    if (postalCode) body.psc = String(postalCode);

    const data = await searchStandardizedAddresses(body);
    const addresses = (data.standardizovaneAdresy || data.adresy || []).map((addr: any) => {
      const parts: string[] = [];
      if (addr.nazevUlice) {
        let line = addr.nazevUlice;
        if (addr.cisloDomovni) {
          line += ` ${addr.cisloDomovni}`;
          if (addr.cisloOrientacni) line += `/${addr.cisloOrientacni}`;
        }
        parts.push(line);
      } else if (addr.cisloDomovni) {
        parts.push(`č.p. ${addr.cisloDomovni}`);
      }
      if (addr.nazevCastiObce && addr.nazevCastiObce !== addr.nazevObce) {
        parts.push(addr.nazevCastiObce);
      }
      if (addr.psc && addr.nazevObce) {
        parts.push(`${addr.psc} ${addr.nazevObce}`);
      } else if (addr.nazevObce) {
        parts.push(addr.nazevObce);
      }
      return {
        formatted: parts.join(", "),
        ruianCode: addr.kodAdresnihoMista || null,
        city: addr.nazevObce || null,
        street: addr.nazevUlice || null,
        houseNumber: addr.cisloDomovni || null,
        postalCode: addr.psc || null,
      };
    });

    res.json({ total: data.pocetCelkem ?? addresses.length, addresses });
  } catch (error: any) {
    log.error("api_address_error", { error: error.message });
    res.status(502).json({ error: "Failed to validate address" });
  }
});

export default router;
