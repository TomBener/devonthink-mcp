import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import {
	lookupBibliographyMetadataByPath,
	lookupBibliographyMetadataByCitationKey,
	clearBibliographyMetadataCache,
	BibliographyMetadataMatch,
} from "../../src/utils/bibliographyMetadata.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(currentDir, "../fixtures/bibliography");
const jsonFixturePath = path.join(fixturesDir, "bibliography.json");
const bibFixturePath = path.join(fixturesDir, "bibliography.bib");

describe("lookupBibliographyMetadataByPath", () => {
	beforeEach(() => {
		clearBibliographyMetadataCache();
	});

	it("finds metadata from the JSON export when the attachment path matches directly", async () => {
		const finderPath = "/Users/alex/Documents/Bibliography/storage/ABC12345/Smith2024.pdf";

		const result = await lookupBibliographyMetadataByPath(finderPath, {
			jsonPath: jsonFixturePath,
			bibPath: bibFixturePath,
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		expect(result.source).toBe("json");
		const match = result as Extract<BibliographyMetadataMatch, { source: "json" }>;
		expect(match.item.id).toBe("smith2024deep");
		expect(match.propertyPath).toEqual(["attachments", "[0]", "localPath"]);
		expect(match.matchValue).toContain("Smith2024.pdf");
		expect(match.matchType).toBe("path");
		expect(match.descriptor.citationKey).toBe("smith2024deep");
		expect(match.descriptor.attachmentPaths).toContain(
			"/Users/alex/Documents/Bibliography/storage/ABC12345/Smith2024.pdf",
		);
	});

	it("finds metadata from the JSON export when the attachment stores a file URL", async () => {
		const finderPath =
			"/Users/alex/Documents/Bibliography/storage/ABC12345/Smith2024-supplement.pdf";

		const result = await lookupBibliographyMetadataByPath(finderPath, {
			jsonPath: jsonFixturePath,
			bibPath: bibFixturePath,
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		expect(result.source).toBe("json");
		const match = result as Extract<BibliographyMetadataMatch, { source: "json" }>;
		expect(match.item.id).toBe("smith2024deep");
		expect(match.propertyPath).toEqual(["attachments", "[1]", "localPath"]);
		expect(match.descriptor.attachmentPaths).toContain(
			"/Users/alex/Documents/Bibliography/storage/ABC12345/Smith2024-supplement.pdf",
		);
	});

	it("falls back to the BibTeX export when JSON is missing the attachment", async () => {
		const finderPath = "/Users/alex/Documents/Bibliography/storage/GAR5566/Garcia2021.pdf";

		const result = await lookupBibliographyMetadataByPath(finderPath, {
			jsonPath: jsonFixturePath,
			bibPath: bibFixturePath,
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		expect(result.source).toBe("bib");
		const match = result as Extract<BibliographyMetadataMatch, { source: "bib" }>;
		expect(match.entry.key).toBe("garcia2021context");
		expect(match.entry.fields.file).toContain("Garcia2021.pdf");
		expect(match.rawEntry).toContain("@inproceedings");
		expect(match.descriptor.citationKey).toBe("garcia2021context");
		expect(match.descriptor.attachmentPaths[0]).toContain("Garcia2021.pdf");
	});

	it("returns detailed errors when the attachment cannot be found", async () => {
		const finderPath = "/Users/alex/Documents/Bibliography/storage/UNKNOWN/item.pdf";

		const result = await lookupBibliographyMetadataByPath(finderPath, {
			jsonPath: jsonFixturePath,
			bibPath: bibFixturePath,
		});

		expect(result.success).toBe(false);
		if (result.success) return;

		expect(result.errors).toHaveLength(2);
		expect(result.errors[0]).toContain("No matching entry");
		expect(result.errors[1]).toContain("No matching entry");
	});
});

describe("lookupBibliographyMetadataByCitationKey", () => {
	beforeEach(() => {
		clearBibliographyMetadataCache();
	});

	it("resolves a citation key using the JSON export", async () => {
		const result = await lookupBibliographyMetadataByCitationKey("smith2024deep", {
			jsonPath: jsonFixturePath,
			bibPath: bibFixturePath,
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		expect(result.source).toBe("json");
		expect(result.matchType).toBe("citationKey");
		expect(result.descriptor.citationKey).toBe("smith2024deep");
		expect(result.descriptor.attachmentPaths.length).toBeGreaterThanOrEqual(1);
	});

	it("resolves a citation key from the BibTeX export when not present in JSON", async () => {
		const result = await lookupBibliographyMetadataByCitationKey("garcia2021context", {
			jsonPath: jsonFixturePath,
			bibPath: bibFixturePath,
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		expect(result.source).toBe("bib");
		expect(result.descriptor.citationKey).toBe("garcia2021context");
		expect(result.descriptor.attachmentPaths[0]).toContain("Garcia2021.pdf");
	});

	it("reports an error when the citation key is missing", async () => {
		const result = await lookupBibliographyMetadataByCitationKey("unknown-key", {
			jsonPath: jsonFixturePath,
			bibPath: bibFixturePath,
		});

		expect(result.success).toBe(false);
		if (result.success) return;

		expect(result.errors).toHaveLength(2);
		expect(result.errors[0]).toContain("No entry");
		expect(result.errors[1]).toContain("No entry");
	});
});
