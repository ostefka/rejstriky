import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchCompanies } from "../ares/client.js";
import { log } from "../logger.js";
import {
  resolveLegalForm,
  formatAddress,
  resolveRegistryStatus,
} from "../formatters/czech.js";

export function registerSearchCompanies(server: McpServer) {
  server.registerTool(
    "search_companies",
    {
      description:
        "Search for Czech companies in the ARES business registry by name, IČO, address, legal form, or CZ-NACE industry code. Returns a list of matching companies with basic info.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Company name or part of name to search for (Czech: obchodní jméno). Alias: name."
          ),
        name: z
          .string()
          .optional()
          .describe(
            "Company name or part of name to search for (Czech: obchodní jméno). Same as query."
          ),
        ico: z
          .string()
          .optional()
          .describe("Czech company identification number (IČO) - 8 digits"),
        city: z
          .string()
          .optional()
          .describe("City name to filter by (Czech: obec)"),
        street: z
          .string()
          .optional()
          .describe("Street name to filter by (Czech: ulice)"),
        maxResults: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum number of results to return (default: 10, max: 100)"),
      },
    },
    async ({ query, name, ico, city, street, maxResults }) => {
      try {
        const companyName = query || name;
        const params: any = {};
        if (companyName) params.obchodniJmeno = companyName;
        if (ico) params.ico = [ico];
        if (city || street) {
          const addressParts = [street, city].filter(Boolean);
          params.sidlo = { textovaAdresa: addressParts.join(", ") };
          if (!companyName && !ico) {
            params.pravniForma = ["112", "121"];
          }
        }
        params.pocet = maxResults ?? 10;

        if (!companyName && !ico && !city && !street) {
          return {
            content: [
              { type: "text" as const, text: "Zadejte alespoň jedno kritérium: název firmy, IČO, město nebo ulici." },
            ],
          };
        }

        const data = await searchCompanies(params);
        const companies = data.ekonomickeSubjekty || [];
        const total = data.pocetCelkem ?? companies.length;

        if (companies.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "Nebyly nalezeny žádné firmy odpovídající zadaným kritériím." },
            ],
          };
        }

        let md = `## Výsledky hledání ARES\n**Nalezeno ${total} firem** (zobrazeno ${companies.length})\n\n`;

        for (const c of companies) {
          const status = resolveRegistryStatus(c.stavSubjektu, c.datumZaniku);
          const legalForm = resolveLegalForm(c.pravniForma);
          const addr = formatAddress(c.sidlo);

          md += `### ${c.obchodniJmeno || "N/A"}\n`;
          md += `- **IČO:** ${c.ico || "neuvedeno (zahraniční subjekt)"}\n`;
          md += `- **Stav:** ${status}\n`;
          md += `- **Právní forma:** ${legalForm}\n`;
          md += `- **Sídlo:** ${addr}\n`;
          if (c.datumVzniku) md += `- **Datum vzniku:** ${c.datumVzniku}\n`;
          md += `\n`;
        }

        return { content: [{ type: "text" as const, text: md }] };
      } catch (error: any) {
        log.error("search_companies_error", { error: error.message });
        if (error.message?.includes("VYSTUP_PRILIS_MNOHO_VYSLEDKU")) {
          return {
            content: [{ type: "text" as const, text: "Příliš mnoho výsledků. Upřesněte hledání přidáním názvu firmy nebo IČO." }],
          };
        }
        return {
          content: [{ type: "text" as const, text: `Chyba při hledání firem: ${error.message}` }],
        };
      }
    }
  );
}
