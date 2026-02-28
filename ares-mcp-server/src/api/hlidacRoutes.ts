import { Router } from "express";
import { log } from "../logger.js";
import {
  searchContracts,
  getContractDetail,
  searchInsolvency,
  getInsolvencyDetail,
} from "../hlidacstatu/client.js";

const router = Router();

const ATTRIBUTION = {
  source: "Hlídač státu",
  url: "https://www.hlidacstatu.cz",
  license: "CC BY 3.0 CZ",
  licenseUrl: "https://creativecommons.org/licenses/by/3.0/cz/",
};

// GET /api/hs/contracts/search - Search contracts
router.get("/contracts/search", async (req, res) => {
  try {
    const { query, page, sort } = req.query;

    if (!query) {
      res.status(400).json({ error: "query parameter is required (e.g. ico:12345678 or free text)" });
      return;
    }

    const data = await searchContracts(
      String(query),
      page ? parseInt(String(page), 10) : 1,
      25,
      sort ? parseInt(String(sort), 10) : 0,
    );

    const contracts = (data.results || []).map((c: any) => ({
      id: c.id,
      subject: c.predmet || null,
      amountCZK: c.calculatedPriceWithVATinCZK ?? null,
      amountWithoutVAT: c.hodnotaBezDph ?? null,
      payer: c.platce ? { name: c.platce.nazev, ico: c.platce.ico } : null,
      recipients: (c.prijemce || []).map((p: any) => ({ name: p.nazev, ico: p.ico })),
      dateSigned: c.datumUzavreni ? c.datumUzavreni.split("T")[0] : null,
      issues: (c.issues || []).map((i: any) => i.title || i.issueTypeId),
      sourceUrl: `https://www.hlidacstatu.cz/Detail/${c.id}`,
    }));

    res.json({ total: data.total ?? 0, page: page ? parseInt(String(page), 10) : 1, contracts, attribution: ATTRIBUTION });
  } catch (error: any) {
    log.error("hs_contracts_search_error", { error: error.message });
    res.status(502).json({ error: "Failed to search contracts" });
  }
});

// GET /api/hs/contracts/:id - Contract detail
router.get("/contracts/:id", async (req, res) => {
  try {
    const c = await getContractDetail(req.params.id);

    const result = {
      id: c.id,
      subject: c.predmet || null,
      amountCZK: c.calculatedPriceWithVATinCZK ?? null,
      amountWithoutVAT: c.hodnotaBezDph ?? null,
      dateSigned: c.datumUzavreni ? c.datumUzavreni.split("T")[0] : null,
      datePublished: c.casZverejneni ? c.casZverejneni.split("T")[0] : null,
      payer: c.platce
        ? { name: c.platce.nazev, ico: c.platce.ico, address: c.platce.adresa || null }
        : null,
      recipients: (c.prijemce || []).map((p: any) => ({
        name: p.nazev,
        ico: p.ico,
        address: p.adresa || null,
      })),
      issues: (c.issues || []).map((i: any) => i.title || i.issueTypeId),
      attachments: (c.prilohy || []).map((a: any) => ({
        name: a.nazevSouboru || null,
        wordCount: a.wordCount ?? null,
      })),
      sourceUrl: `https://www.hlidacstatu.cz/Detail/${c.id}`,
      attribution: ATTRIBUTION,
    };

    res.json(result);
  } catch (error: any) {
    log.error("hs_contract_detail_error", { error: error.message });
    res.status(error.message?.includes("404") ? 404 : 502).json({ error: error.message?.includes("404") ? "Contract not found" : "Failed to fetch contract detail" });
  }
});

// GET /api/hs/insolvency/search - Search insolvency cases
router.get("/insolvency/search", async (req, res) => {
  try {
    const { query, page } = req.query;

    if (!query) {
      res.status(400).json({ error: "query parameter is required (e.g. ico:12345678 or name)" });
      return;
    }

    const data = await searchInsolvency(
      String(query),
      page ? parseInt(String(page), 10) : 1,
    );

    const cases = (data.results || []).map((r: any) => ({
      courtFileNumber: r.spisovaZnacka || null,
      status: r.stav || null,
      court: r.soud || null,
      dateFiled: r.datumZalozeni ? r.datumZalozeni.split("T")[0] : null,
      debtors: (r.dluznici || []).map((d: any) => ({
        name: d.plneJmeno || d.nazev || null,
        ico: d.ico || null,
      })),
      creditorsCount: r.veriteleCount ?? (r.veritele || []).length,
      administrators: (r.spravci || []).map((s: any) => s.plneJmeno || s.nazev || null),
      sourceUrl: `https://www.hlidacstatu.cz/Insolvence/Rizeni/${(r.spisovaZnacka || "").replace(/\s+/g, "-").replace(/\//g, "-")}`,
    }));

    res.json({ total: data.total ?? 0, page: page ? parseInt(String(page), 10) : 1, cases, attribution: ATTRIBUTION });
  } catch (error: any) {
    log.error("hs_insolvency_search_error", { error: error.message });
    res.status(502).json({ error: "Failed to search insolvency cases" });
  }
});

// GET /api/hs/insolvency/detail?id=... - Insolvency case detail
router.get("/insolvency/detail", async (req, res) => {
  try {
    const id = String(req.query.id || "");
    if (!id) {
      res.status(400).json({ error: "id query parameter is required (e.g. ?id=INS 10525/2016)" });
      return;
    }

    const r = await getInsolvencyDetail(id);

    const result = {
      courtFileNumber: r.spisovaZnacka || id,
      status: r.stav || null,
      court: r.soud || null,
      dateFiled: r.datumZalozeni ? r.datumZalozeni.split("T")[0] : null,
      debtors: (r.dluznici || []).map((d: any) => ({
        name: d.plneJmeno || d.nazev || null,
        ico: d.ico || null,
        address: d.adresa || null,
      })),
      creditorsCount: r.veriteleCount ?? (r.veritele || []).length,
      administrators: (r.spravci || []).map((s: any) => ({
        name: s.plneJmeno || s.nazev || null,
        address: s.adresa || null,
      })),
      documentsCount: r.dokumenty ? r.dokumenty.length : 0,
      recentDocuments: (r.dokumenty || []).slice(0, 5).map((doc: any) => ({
        date: doc.datumVlozeni ? doc.datumVlozeni.split("T")[0] : null,
        description: doc.popis || doc.typUdalosti || null,
      })),
      sourceUrl: `https://www.hlidacstatu.cz/Insolvence/Rizeni/${(r.spisovaZnacka || id).replace(/\s+/g, "-").replace(/\//g, "-")}`,
      attribution: ATTRIBUTION,
    };

    res.json(result);
  } catch (error: any) {
    log.error("hs_insolvency_detail_error", { error: error.message });
    res.status(error.message?.includes("404") ? 404 : 502).json({ error: error.message?.includes("404") ? "Insolvency case not found" : "Failed to fetch insolvency detail" });
  }
});

export default router;
