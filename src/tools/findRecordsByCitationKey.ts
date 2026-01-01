import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Tool, ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { executeJxa } from "../applescript/execute.js";
import {
	generateFinderPathVariants,
	lookupBibliographyMetadataByCitationKey,
} from "../utils/bibliographyMetadata.js";
import type { BibliographyMetadataMatch } from "../utils/bibliographyMetadata.js";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

const FinderPathLookupSchema = z
	.object({
		citationKey: z
			.string()
			.min(1, "citationKey must not be empty")
			.describe("Bibliography citation key"),
		bibliographyJsonPath: z
			.string()
			.optional()
			.describe("Override path to Bibliography JSON export"),
		bibliographyBibPath: z
			.string()
			.optional()
			.describe("Override path to Bibliography BibTeX export"),
		maxRecordsPerPath: z
			.number()
			.int()
			.min(1)
			.max(50)
			.optional()
			.describe(
				"Maximum number of DEVONthink records to return for each attachment path (default 5)",
			),
	})
	.strict();

type FinderPathLookupInput = z.infer<typeof FinderPathLookupSchema>;

interface FinderPathRecord {
	id?: number | null;
	uuid?: string | null;
	name?: string | null;
	path?: string | null;
	location?: string | null;
	type?: string | null;
	url?: string | null;
	referenceURL?: string | null;
	tags?: string[] | null;
}

interface FinderPathLookupResult {
	originalPath: string;
	records: FinderPathRecord[];
}

interface FinderPathLookupResponse {
	success: boolean;
	results?: FinderPathLookupResult[];
	error?: string;
}

interface CitationLookupSuccess {
	success: true;
	citationKey: string;
	bibliographyMetadata: string | null;
	devonthinkRecords: FinderPathRecord[];
}

interface CitationLookupFailure {
	success: false;
	error: string;
	citationKey: string;
	details?: string[];
	pathsChecked: {
		json?: string | null;
		bib?: string | null;
	};
}

const buildFinderLookupScript = (
	requests: Array<{ path: string; variants: string[] }>,
	maxPerPath: number,
): string => {
	const payload = JSON.stringify({ requests, maxPerPath });

	// Simplified version of convertDevonthinkRecord that only returns essential fields
	const convertRecordSimplified = `
function convertDevonthinkRecord(record) {
  if (!record) return null;

  const isValuePresent = (value) => {
    if (value === undefined || value === null) return false;
    if (typeof value === "string" && value.trim() === "") return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  };

  const converted = {};
  try {
    const id = record.id();
    const uuid = record.uuid();
    const name = record.name();
    const type = record.type();
    const location = record.location();
    const path = record.path();
    const url = record.url();
    const referenceURL = record.referenceURL();
    const tags = record.tags();

    if (isValuePresent(id)) converted["id"] = id;
    if (isValuePresent(uuid)) converted["uuid"] = uuid;
    if (isValuePresent(name)) converted["name"] = name;
    if (isValuePresent(type)) converted["type"] = type;
    if (isValuePresent(location)) converted["location"] = location;
    if (isValuePresent(path)) converted["path"] = path;
    if (isValuePresent(url)) converted["url"] = url;
    if (isValuePresent(referenceURL)) converted["referenceURL"] = referenceURL;
    if (isValuePresent(tags)) converted["tags"] = tags;
  } catch (e) {
    // Continue with what we have
  }

  return converted;
}`;

	return `
    (() => {
      const theApp = Application("DEVONthink");
      theApp.includeStandardAdditions = true;
      ${convertRecordSimplified}

      try {
        const payload = ${payload};
        const results = [];
        const maxPerPath = payload.maxPerPath || 5;

        payload.requests.forEach(request => {
          const records = [];
          const recordByUUID = {};

          request.variants.forEach(variant => {
            if (!variant) return;

            try {
              const matches = theApp.lookupRecordsWithPath(variant);
              if (matches && matches.length > 0) {
                matches.slice(0, maxPerPath).forEach(record => {
                  const converted = convertDevonthinkRecord(record);
                  if (!converted) return;
                  const uuid = converted.uuid || ("id:" + converted.id);
                  if (uuid && !recordByUUID[uuid]) {
                    recordByUUID[uuid] = true;
                    records.push(converted);
                  }
                });
              }
            } catch (error) {
              // Silently continue on errors
            }
          });

          results.push({
            originalPath: request.path,
            records
          });
        });

        return JSON.stringify({ success: true, results });
      } catch (error) {
        return JSON.stringify({
          success: false,
          error: String(error)
        });
      }
    })();
  `;
};

const lookupRecordsForAttachments = async (
	paths: string[],
	maxPerPath: number,
): Promise<FinderPathLookupResult[]> => {
	if (paths.length === 0) {
		return [];
	}

	const requests = paths.map((pathValue) => {
		const variants = new Set<string>();
		const trimmed = pathValue.trim();
		if (trimmed) {
			variants.add(trimmed);
		}
		for (const variant of generateFinderPathVariants(trimmed)) {
			if (variant.trim()) {
				variants.add(variant.trim());
			}
		}
		return {
			path: trimmed,
			variants: Array.from(variants),
		};
	});

	const script = buildFinderLookupScript(requests, maxPerPath);
	const response = await executeJxa<FinderPathLookupResponse>(script);

	if (!response.success) {
		throw new Error(response.error ?? "Failed to look up records by Finder path");
	}

	return response.results ?? [];
};

const isValuePresent = (value: unknown): boolean => {
	if (value === undefined || value === null) return false;
	if (typeof value === "string" && value.trim() === "") return false;
	if (Array.isArray(value) && value.length === 0) return false;
	return true;
};

const buildMetadataPayload = (match: BibliographyMetadataMatch): string | null => {
	if (match.source === "json") {
		const item = match.item;
		return isValuePresent(item.title) ? String(item.title) : null;
	} else {
		// For BibTeX, extract title from fields
		return isValuePresent(match.entry.fields.title) ? String(match.entry.fields.title) : null;
	}
};

const findRecordsByCitationKey = async (
	input: FinderPathLookupInput,
): Promise<CitationLookupSuccess | CitationLookupFailure> => {
	const { citationKey, bibliographyJsonPath, bibliographyBibPath, maxRecordsPerPath = 5 } = input;
	const trimmedKey = citationKey.trim();
	const metadataJsonPath = bibliographyJsonPath ?? process.env.BIBLIOGRAPHY_JSON ?? null;
	const metadataBibPath = bibliographyBibPath ?? process.env.BIBLIOGRAPHY_BIB ?? null;
	const pathsChecked = {
		json: metadataJsonPath,
		bib: metadataBibPath,
	};

	const lookupResult = await lookupBibliographyMetadataByCitationKey(trimmedKey, {
		jsonPath: metadataJsonPath ?? undefined,
		bibPath: metadataBibPath ?? undefined,
	});

	if (!lookupResult.success) {
		return {
			success: false,
			error: `No Bibliography metadata entry found for citation key '${trimmedKey}'`,
			citationKey: trimmedKey,
			details: lookupResult.errors,
			pathsChecked,
		};
	}

	const descriptor = lookupResult.descriptor;
	const attachments = descriptor.attachmentPaths;

	// Collect all DEVONthink records across all attachments
	const allRecords: FinderPathRecord[] = [];
	if (attachments.length > 0) {
		try {
			const recordMatches = await lookupRecordsForAttachments(attachments, maxRecordsPerPath);
			for (const match of recordMatches) {
				allRecords.push(...match.records);
			}
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
				citationKey: trimmedKey,
				details: [`Attachment lookup failed for ${attachments.length} path(s)`],
				pathsChecked,
			};
		}
	}

	return {
		success: true,
		citationKey: trimmedKey,
		bibliographyMetadata: buildMetadataPayload(lookupResult),
		devonthinkRecords: allRecords,
	};
};

export const findRecordsByCitationKeyTool: Tool = {
	name: "get_records_by_citation_key",
	description:
		"Resolve a citation key to its attached files and matching DEVONthink records. Returns bibliography metadata and any DEVONthink records whose Finder paths match the attachment entries.",
	inputSchema: zodToJsonSchema(FinderPathLookupSchema) as ToolInput,
	run: findRecordsByCitationKey,
};
