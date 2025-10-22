import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { Tool, ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { executeJxa } from "../applescript/execute.js";
import {
	generateFinderPathVariants,
	lookupZoteroMetadataByCitationKey,
} from "../utils/zoteroMetadata.js";
import {
	convertDevonthinkRecordHelper,
} from "../utils/jxaHelpers.js";
import type {
	ZoteroMatchType,
	ZoteroMetadataDescriptor,
	ZoteroMetadataMatch,
} from "../utils/zoteroMetadata.js";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

const FinderPathLookupSchema = z
	.object({
		citationKey: z.string().min(1, "citationKey must not be empty").describe("Zotero citation key"),
		zoteroJsonPath: z
			.string()
			.optional()
			.describe("Override path to Zotero JSON export"),
		zoteroBibPath: z
			.string()
			.optional()
			.describe("Override path to Zotero BibTeX export"),
		maxRecordsPerPath: z
			.number()
			.int()
			.min(1)
			.max(50)
			.optional()
			.describe("Maximum number of DEVONthink records to return for each attachment path (default 5)"),
	})
	.strict();

type FinderPathLookupInput = z.infer<typeof FinderPathLookupSchema>;

interface FinderPathRecord {
	id?: number | null;
	uuid?: string | null;
	name?: string | null;
	path?: string | null;
	location?: string | null;
	recordType?: string | null;
	databaseName?: string | null;
	databaseUuid?: string | null;
	url?: string | null;
	referenceURL?: string | null;
	kind?: string | null;
}

interface FinderPathLookupResult {
	originalPath: string;
	triedVariants: string[];
	records: FinderPathRecord[];
	errors?: string[];
}

interface FinderPathLookupResponse {
	success: boolean;
	results?: FinderPathLookupResult[];
	error?: string;
}

interface CitationLookupSuccess {
	success: true;
	citationKey: string;
	source: "json" | "bib";
	matchType: ZoteroMatchType;
	descriptor: ZoteroMetadataDescriptor;
	metadata: Record<string, unknown>;
	attachments: string[];
	recordMatches: FinderPathLookupResult[];
	pathsChecked: {
		json?: string | null;
		bib?: string | null;
	};
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

	return `
    (() => {
      const theApp = Application("DEVONthink");
      theApp.includeStandardAdditions = true;
      ${convertDevonthinkRecordHelper}
      
      try {
        const payload = ${payload};
        const results = [];
        const maxPerPath = payload.maxPerPath || 5;
        
        payload.requests.forEach(request => {
          const triedVariants = [];
          const records = [];
          const recordByUUID = {};
          const errors = [];
          
          request.variants.forEach(variant => {
            if (!variant || triedVariants.includes(variant)) {
              return;
            }
            triedVariants.push(variant);
            
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
              errors.push(String(error));
            }
          });
          
          results.push({
            originalPath: request.path,
            triedVariants,
            records,
            errors: errors.length > 0 ? errors : undefined
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

const buildMetadataPayload = (match: ZoteroMetadataMatch): Record<string, unknown> => {
	if (match.source === "json") {
		return {
			item: match.item,
			matchType: match.matchType,
			matchValue: match.matchValue,
			propertyPath: match.propertyPath,
			matchedField: match.matchedField,
			metadataFile: match.metadataFile,
		};
	}

	return {
		entryType: match.entry.type,
		citationKey: match.entry.key,
		fields: match.entry.fields,
		matchType: match.matchType,
		matchValue: match.matchValue,
		matchedField: match.matchedField,
		rawEntry: match.rawEntry,
		metadataFile: match.metadataFile,
	};
};

const findRecordsByCitationKey = async (
	input: FinderPathLookupInput,
): Promise<CitationLookupSuccess | CitationLookupFailure> => {
	const { citationKey, zoteroJsonPath, zoteroBibPath, maxRecordsPerPath = 5 } = input;
	const trimmedKey = citationKey.trim();
	const metadataJsonPath = zoteroJsonPath ?? process.env.ZOTERO_BIBLIOGRAPHY_JSON ?? null;
	const metadataBibPath = zoteroBibPath ?? process.env.ZOTERO_BIBLIOGRAPHY_BIB ?? null;
	const pathsChecked = {
		json: metadataJsonPath,
		bib: metadataBibPath,
	};

	const lookupResult = await lookupZoteroMetadataByCitationKey(trimmedKey, {
		jsonPath: metadataJsonPath ?? undefined,
		bibPath: metadataBibPath ?? undefined,
	});

	if (!lookupResult.success) {
		return {
			success: false,
			error: `No Zotero metadata entry found for citation key '${trimmedKey}'`,
			citationKey: trimmedKey,
			details: lookupResult.errors,
			pathsChecked,
		};
	}

	const descriptor = lookupResult.descriptor;
	const attachments = descriptor.attachmentPaths;

	let recordMatches: FinderPathLookupResult[] = [];
	if (attachments.length > 0) {
		try {
			recordMatches = await lookupRecordsForAttachments(attachments, maxRecordsPerPath);
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
		source: lookupResult.source,
		matchType: lookupResult.matchType,
		descriptor,
		metadata: buildMetadataPayload(lookupResult),
		attachments,
		recordMatches,
		pathsChecked,
	};
};

export const findRecordsByCitationKeyTool: Tool = {
	name: "find_records_by_citation_key",
	description:
		"Resolve a Zotero citation key to its attached files and matching DEVONthink records. Returns Zotero metadata and any DEVONthink records whose Finder paths match the attachment entries.",
	inputSchema: zodToJsonSchema(FinderPathLookupSchema) as ToolInput,
	run: findRecordsByCitationKey,
};

