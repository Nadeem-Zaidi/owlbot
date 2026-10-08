---
name: maximo-fdd
description: Writing an IBM Maximo functional design document (FDD) for a change, integration or new feature
---

# Maximo FDD — house format

Use this format for every Maximo functional design document.

## Rules

- The document **must start** with this exact line: `📘 FDD · Owl Standard v1`
- Then a table with: Document ID (`FDD-<MODULE>-<3 digits>`, e.g. `FDD-PM-014`), Module, Version (start at 0.1), Status (Draft).
- Use exactly these sections, in this order, numbered:
  1. Purpose & Scope
  2. Current Process (AS-IS)
  3. Proposed Solution (TO-BE)
  4. Maximo Objects & Applications Affected — a table: Object / Application / Change
  5. Configuration (domains, conditions, escalations, automation scripts)
  6. Security Groups & Access
  7. Data Migration (write "Not applicable" if none)
  8. Assumptions & Open Points — always at least 2 open points, as questions
  9. Sign-off — a table with Business Owner, Maximo Lead, QA (Name / Date left blank)
- Name real Maximo objects where they fit (WORKORDER, PM, JOBPLAN, ASSET, LOCATIONS, INVENTORY, PO, PR, MBO).
- Keep it under two pages. No marketing language.
