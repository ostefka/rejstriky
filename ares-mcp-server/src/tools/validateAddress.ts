import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchStandardizedAddresses } from "../ares/client.js";
import { log } from "../logger.js";

export function registerValidateAddress(server: McpServer) {
  server.registerTool(
    "validate_czech_address",
    {
      description:
        "Validate and standardize a Czech address using the ARES standardized address database (RÚIAN). Returns the official standardized form of the address if found. Useful for verifying if an address is valid and getting the official format.",
      inputSchema: {
        city: z
          .string()
          .describe("City or municipality name (Czech: obec)"),
        street: z
          .string()
          .optional()
          .describe("Street name (Czech: ulice)"),
        houseNumber: z
          .string()
          .optional()
          .describe("House number (číslo popisné or číslo evidenční)"),
        postalCode: z
          .string()
          .optional()
          .describe("Postal code / PSČ (5 digits, e.g. '11000')"),
        maxResults: z
          .number()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum results to return (default: 5)"),
      },
    },
    async ({ city, street, houseNumber, postalCode, maxResults }) => {
      try {
        const body: Record<string, any> = {
        nazevObce: city,
        pocet: maxResults ?? 5,
        typStandardizaceAdresy: "VYHOVUJICI_ADRESY",
      };
      if (street) body.nazevUlice = street;
      if (houseNumber) body.cisloDomovni = houseNumber;
      if (postalCode) body.psc = postalCode;

      const data = await searchStandardizedAddresses(body);
      const addresses = data.standardizovaneAdresy || data.adresy || [];

      if (addresses.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `## Ověření adresy\n\nNebyly nalezeny žádné standardizované adresy odpovídající kritériím. Adresa nemusí existovat v databázi RÚIAN nebo jsou kritéria příliš specifická.\n\n**Hledáno:** ${[city, street, houseNumber, postalCode].filter(Boolean).join(", ")}`,
            },
          ],
        };
      }

      let md = `## Výsledky ověření adresy\n**Nalezeno ${data.pocetCelkem ?? addresses.length} adres** (zobrazeno ${addresses.length})\n\n`;

      for (const addr of addresses) {
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

        md += `- **${parts.join(", ")}**`;
        if (addr.kodAdresnihoMista) md += ` (kód RÚIAN: ${addr.kodAdresnihoMista})`;
        md += `\n`;
      }

      return { content: [{ type: "text" as const, text: md }] };
      } catch (error: any) {
        log.error("validate_czech_address_error", { error: error.message });
        return {
          content: [{ type: "text" as const, text: `Chyba při ověřování adresy: ${error.message}` }],
        };
      }
    }
  );
}
