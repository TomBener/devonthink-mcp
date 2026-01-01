import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

export type BibliographyMatchType = "path" | "citationKey" | "bibliographyId";

export interface BibliographyMetadataDescriptor {
	source: "json" | "bib";
	citationKey?: string | null;
	bibliographyId?: string | null;
	title?: string | null;
	attachmentPaths: string[];
}

export interface BibliographyJsonMatch {
	success: true;
	source: "json";
	item: Record<string, unknown>;
	matchType: BibliographyMatchType;
	matchValue: string;
	propertyPath: string[];
	descriptor: BibliographyMetadataDescriptor;
	metadataFile?: string;
	matchedField?: string;
}

export interface BibliographyBibMatch {
	success: true;
	source: "bib";
	entry: BibEntry;
	rawEntry: string;
	matchType: BibliographyMatchType;
	matchValue: string;
	descriptor: BibliographyMetadataDescriptor;
	metadataFile?: string;
	matchedField?: string;
}

export type BibliographyMetadataMatch = BibliographyJsonMatch | BibliographyBibMatch;

export interface BibliographyLookupOptions {
	jsonPath?: string;
	bibPath?: string;
}

export interface BibEntry {
	type: string;
	key: string;
	fields: Record<string, string>;
	rawEntry?: string;
}

interface BibParseState {
	value: string;
	index: number;
}

const CACHE = {
	json: new Map<string, unknown>(),
	bib: new Map<string, BibEntry[]>(),
};

const readJsonCache = async (filePath: string): Promise<unknown | null> => {
	if (CACHE.json.has(filePath)) {
		return CACHE.json.get(filePath) ?? null;
	}

	try {
		const raw = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		CACHE.json.set(filePath, parsed);
		return parsed;
	} catch {
		return null;
	}
};

const fileExists = async (filePath: string): Promise<boolean> => {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
};

const normalizeComparisonString = (value: string): string => {
	let normalized = value.trim();
	if (normalized.toLowerCase().startsWith("file://")) {
		try {
			normalized = fileURLToPath(normalized);
		} catch {
			// Ignore URL parse errors and fall back to raw string
		}
	}

	normalized = normalized.replace(/\\/g, "/");
	return normalized;
};

const generatePathVariants = (finderPath: string): string[] => {
	const normalized = finderPath.replace(/\\/g, "/");
	const variants = new Set<string>();
	variants.add(normalized);

	if (normalized.startsWith("/")) {
		variants.add(`:${normalized}`);
		variants.add(`:${normalized}:`);
	}

	const encoded = encodeURI(normalized);
	variants.add(encoded);
	if (encoded.startsWith("/")) {
		variants.add(`:${encoded}`);
		variants.add(`:${encoded}:`);
	}

	const fileUrl = pathToFileURL(normalized).toString();
	variants.add(fileUrl);
	variants.add(fileUrl.replace("file://", ""));

	variants.add(normalized.replace(/ /g, "\\ "));
	variants.add(normalized.replace(/ /g, "%20"));

	return Array.from(variants).map((variant) => normalizeComparisonString(variant));
};

export const generateFinderPathVariants = (finderPath: string): string[] =>
	generatePathVariants(finderPath);

const matchStringAgainstVariants = (value: string, variants: string[]): boolean => {
	const normalizedValue = normalizeComparisonString(value);

	return variants.some((variant) => {
		if (normalizedValue === variant) return true;
		return normalizedValue.includes(variant);
	});
};

const decodeUriSafe = (value: string): string => {
	try {
		return decodeURI(value);
	} catch {
		return value;
	}
};

const expandHomeDirectory = (value: string): string => {
	if (value.startsWith("~/")) {
		const home = os.homedir();
		if (home) {
			return path.join(home, value.slice(2));
		}
	}
	return value;
};

const PATH_HINT_KEYS = new Set(["path", "localPath", "file", "uri", "url", "relativePath"]);

const ATTACHMENT_EXTENSION_REGEX =
	/\.(pdf|docx?|pptx?|rtf|txt|md|html?|epub|zip|gz|xlsx?|csv|png|jpe?g|gif|tiff|heic)$/i;

const normalizeAttachmentPath = (value: string): string | null => {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	let normalized = normalizeComparisonString(trimmed);
	if (!normalized) {
		return null;
	}

	if (normalized.startsWith(":")) {
		normalized = normalized.slice(1);
	}

	normalized = decodeUriSafe(normalized);
	normalized = expandHomeDirectory(normalized);

	return normalized;
};

const isLikelyLocalAttachment = (value: string, keyHint?: string): boolean => {
	const trimmed = value.trim();
	if (!trimmed) {
		return false;
	}

	if (/^(https?|zotero|attachment):\/\//i.test(trimmed)) {
		return false;
	}

	const normalized = normalizeComparisonString(trimmed);

	if (keyHint && PATH_HINT_KEYS.has(keyHint)) {
		return true;
	}

	if (normalized.startsWith("/") || normalized.startsWith("~") || normalized.startsWith(":")) {
		return true;
	}

	if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
		return true;
	}

	return ATTACHMENT_EXTENSION_REGEX.test(normalized);
};

const collectJsonAttachmentPaths = (item: Record<string, unknown>): string[] => {
	const paths = new Set<string>();

	const visit = (value: unknown, keyHint?: string) => {
		if (typeof value === "string") {
			if (isLikelyLocalAttachment(value, keyHint)) {
				const normalized = normalizeAttachmentPath(value);
				if (normalized) {
					paths.add(normalized);
				}
			}
			return;
		}

		if (Array.isArray(value)) {
			for (const entry of value) {
				visit(entry, keyHint);
			}
			return;
		}

		if (value && typeof value === "object") {
			const obj = value as Record<string, unknown>;
			for (const [childKey, childValue] of Object.entries(obj)) {
				visit(childValue, childKey);
			}
		}
	};

	visit(item);
	return Array.from(paths);
};

const getFirstStringFromKeys = (source: Record<string, unknown>, keys: string[]): string | null => {
	for (const key of keys) {
		const candidate = source[key];
		if (typeof candidate === "string" && candidate.trim()) {
			return candidate.trim();
		}
	}
	return null;
};

const findMatchingTopLevelField = (
	source: Record<string, unknown>,
	keys: string[],
	target: string,
): { value: string; field: string; propertyPath: string[] } | null => {
	const normalizedTarget = normalizeKey(target);

	for (const key of keys) {
		const candidate = source[key];
		if (typeof candidate === "string" && normalizeKey(candidate) === normalizedTarget) {
			return {
				value: candidate,
				field: key,
				propertyPath: [key],
			};
		}
	}

	return null;
};

const buildJsonDescriptor = (item: Record<string, unknown>): BibliographyMetadataDescriptor => {
	const citationKey = getFirstStringFromKeys(item, ["citationKey", "citationkey", "id"]) ?? null;
	const bibliographyId =
		getFirstStringFromKeys(item, ["bibliographyId", "zotero_id", "key", "id"]) ?? null;
	const title = getFirstStringFromKeys(item, ["title"]) ?? null;

	return {
		source: "json",
		citationKey,
		bibliographyId,
		title,
		attachmentPaths: collectJsonAttachmentPaths(item),
	};
};

const parseBibFileField = (value: string): string[] => {
	const segments = value
		.split(";")
		.map((segment) => segment.trim())
		.filter(Boolean);
	const paths: string[] = [];

	for (const segment of segments) {
		const match = segment.match(/^([^:]+):(.+):([^:]+)$/);
		if (match) {
			const rawPath = match[2];
			const normalized = normalizeAttachmentPath(rawPath);
			if (normalized) {
				paths.push(normalized);
			}
		}
	}

	return paths;
};

const collectBibAttachmentPaths = (entry: BibEntry): string[] => {
	const paths = new Set<string>();

	for (const [key, value] of Object.entries(entry.fields)) {
		if (typeof value !== "string") {
			continue;
		}

		if (key.toLowerCase() === "file") {
			for (const parsed of parseBibFileField(value)) {
				paths.add(parsed);
			}
			continue;
		}

		if (PATH_HINT_KEYS.has(key) && isLikelyLocalAttachment(value, key)) {
			const normalized = normalizeAttachmentPath(value);
			if (normalized) {
				paths.add(normalized);
			}
		}
	}

	return Array.from(paths);
};

const buildBibDescriptor = (entry: BibEntry): BibliographyMetadataDescriptor => {
	const citationKey = entry.key ?? null;
	const bibliographyId =
		entry.fields.zotero_id ?? entry.fields.id ?? entry.fields.citationkey ?? null;
	const title = entry.fields.title ?? entry.fields["title"] ?? null;

	return {
		source: "bib",
		citationKey,
		bibliographyId: bibliographyId ?? null,
		title: title ?? null,
		attachmentPaths: collectBibAttachmentPaths(entry),
	};
};

const normalizeKey = (value: string): string => value.trim().toLowerCase();

const getJsonEntries = (data: unknown): unknown[] => {
	if (Array.isArray(data)) {
		return data;
	}

	if (data && typeof data === "object") {
		const container = data as Record<string, unknown>;
		if (Array.isArray(container.items)) {
			return container.items;
		}
		return [data];
	}

	return [];
};

const findPathInJsonValue = (
	value: unknown,
	variants: string[],
	propertyPath: string[],
): { path: string[]; matchValue: string } | null => {
	if (typeof value === "string") {
		if (matchStringAgainstVariants(value, variants)) {
			return { path: propertyPath, matchValue: value };
		}
		return null;
	}

	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			const childResult = findPathInJsonValue(
				value[index],
				variants,
				propertyPath.concat(`[${index}]`),
			);
			if (childResult) {
				return childResult;
			}
		}
		return null;
	}

	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		for (const key of Object.keys(obj)) {
			const childResult = findPathInJsonValue(obj[key], variants, propertyPath.concat(key));
			if (childResult) {
				return childResult;
			}
		}
	}

	return null;
};

const lookupInJson = async (
	finderPath: string,
	filePath: string,
): Promise<BibliographyJsonMatch | null> => {
	const variants = generatePathVariants(finderPath);
	const parsed = await readJsonCache(filePath);
	if (!parsed) {
		return null;
	}

	const entries = getJsonEntries(parsed);
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const matchResult = findPathInJsonValue(entry, variants, []);
		if (matchResult) {
			const descriptor = buildJsonDescriptor(entry as Record<string, unknown>);
			const pathSegments = matchResult.path;
			const matchedField =
				pathSegments.length > 0 ? pathSegments[pathSegments.length - 1] : undefined;

			return {
				success: true,
				source: "json",
				item: entry as Record<string, unknown>,
				matchType: "path",
				matchValue: matchResult.matchValue,
				propertyPath: matchResult.path,
				descriptor,
				metadataFile: filePath,
				matchedField,
			};
		}
	}

	return null;
};

const parseBibValue = (state: BibParseState): string => {
	const { value } = state;
	let { index } = state;

	while (index < value.length && /\s|,/.test(value[index])) {
		index += 1;
	}

	if (index >= value.length) {
		state.index = index;
		return "";
	}

	let result = "";
	const startChar = value[index];
	if (startChar === "{") {
		index += 1;
		let depth = 1;
		while (index < value.length && depth > 0) {
			const currentChar = value[index];
			if (currentChar === "{") depth += 1;
			else if (currentChar === "}") depth -= 1;

			if (depth > 0) {
				result += currentChar;
			}
			index += 1;
		}
		state.index = index;
		return result.trim();
	}

	if (startChar === '"') {
		index += 1;
		while (index < value.length) {
			const currentChar = value[index];
			if (currentChar === '"' && value[index - 1] !== "\\") {
				index += 1;
				break;
			}
			result += currentChar;
			index += 1;
		}
		state.index = index;
		return result.trim();
	}

	while (index < value.length && value[index] !== "," && value[index] !== "\n") {
		result += value[index];
		index += 1;
	}
	state.index = index;
	return result.trim();
};

const parseBibFields = (body: string): Record<string, string> => {
	const fields: Record<string, string> = {};
	const state: BibParseState = { value: body, index: 0 };

	while (state.index < body.length) {
		while (state.index < body.length && /\s|,/.test(body[state.index])) {
			state.index += 1;
		}
		if (state.index >= body.length) break;

		let key = "";
		while (state.index < body.length && /[A-Za-z0-9_\-]/.test(body[state.index])) {
			key += body[state.index];
			state.index += 1;
		}

		key = key.trim();
		if (!key) {
			state.index += 1;
			continue;
		}

		while (state.index < body.length && /\s/.test(body[state.index])) {
			state.index += 1;
		}

		if (body[state.index] !== "=") {
			state.index += 1;
			continue;
		}
		state.index += 1;

		const value = parseBibValue(state);
		fields[key.toLowerCase()] = value;
	}

	return fields;
};

const parseBibEntry = (entryText: string): BibEntry | null => {
	const headerMatch = entryText.match(/^@(\w+)\s*\{\s*([^,]+),/);
	if (!headerMatch) {
		return null;
	}

	const [, type, key] = headerMatch;
	const bodyStart = headerMatch[0].length;
	const body = entryText.slice(bodyStart, entryText.lastIndexOf("}"));
	const fields = parseBibFields(body);

	return {
		type,
		key: key.trim(),
		fields,
		rawEntry: entryText.trim(),
	};
};

const findBibEntries = (content: string): string[] => {
	const entries: string[] = [];
	let index = 0;

	while (index < content.length) {
		const start = content.indexOf("@", index);
		if (start === -1) break;

		let braceIndex = content.indexOf("{", start);
		if (braceIndex === -1) break;

		let depth = 1;
		let currentIndex = braceIndex + 1;

		while (currentIndex < content.length && depth > 0) {
			const char = content[currentIndex];
			if (char === "{") depth += 1;
			if (char === "}") depth -= 1;
			currentIndex += 1;
		}

		if (depth === 0) {
			const entryText = content.slice(start, currentIndex);
			entries.push(entryText);
			index = currentIndex;
		} else {
			break;
		}
	}

	return entries;
};

const readBibCache = async (filePath: string): Promise<BibEntry[] | null> => {
	if (CACHE.bib.has(filePath)) {
		return CACHE.bib.get(filePath) ?? null;
	}

	try {
		const content = await fs.readFile(filePath, "utf8");
		const entryTexts = findBibEntries(content);
		const entries: BibEntry[] = [];

		for (const entryText of entryTexts) {
			const parsed = parseBibEntry(entryText);
			if (parsed) {
				entries.push(parsed);
			}
		}

		CACHE.bib.set(filePath, entries);
		return entries;
	} catch {
		return null;
	}
};

const lookupInBib = async (
	finderPath: string,
	filePath: string,
): Promise<BibliographyBibMatch | null> => {
	const variants = generatePathVariants(finderPath);
	const entries = await readBibCache(filePath);

	if (!entries) {
		return null;
	}

	for (const parsed of entries) {
		for (const [fieldKey, fieldValue] of Object.entries(parsed.fields)) {
			if (typeof fieldValue !== "string") continue;
			if (matchStringAgainstVariants(fieldValue, variants)) {
				const descriptor = buildBibDescriptor(parsed);
				return {
					success: true,
					source: "bib",
					entry: parsed,
					rawEntry: parsed.rawEntry || "",
					matchType: "path",
					matchValue: fieldValue,
					descriptor,
					metadataFile: filePath,
					matchedField: fieldKey,
				};
			}
		}
	}

	return null;
};

const lookupCitationInJson = async (
	citationKey: string,
	filePath: string,
): Promise<BibliographyJsonMatch | null> => {
	const parsed = await readJsonCache(filePath);
	if (!parsed) {
		return null;
	}

	const entries = getJsonEntries(parsed);
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const item = entry as Record<string, unknown>;
		const descriptor = buildJsonDescriptor(item);
		const matchInfo = findMatchingTopLevelField(
			item,
			["citationKey", "citationkey", "id"],
			citationKey,
		);
		if (matchInfo) {
			return {
				success: true,
				source: "json",
				item,
				matchType: "citationKey",
				matchValue: matchInfo.value,
				propertyPath: matchInfo.propertyPath,
				descriptor,
				metadataFile: filePath,
				matchedField: matchInfo.field,
			};
		}
	}

	return null;
};

const lookupCitationInBib = async (
	citationKey: string,
	filePath: string,
): Promise<BibliographyBibMatch | null> => {
	const entries = await readBibCache(filePath);
	if (!entries) {
		return null;
	}

	const normalizedTarget = normalizeKey(citationKey);

	for (const parsed of entries) {
		const descriptor = buildBibDescriptor(parsed);
		if (descriptor.citationKey && normalizeKey(descriptor.citationKey) === normalizedTarget) {
			return {
				success: true,
				source: "bib",
				entry: parsed,
				rawEntry: parsed.rawEntry || "",
				matchType: "citationKey",
				matchValue: descriptor.citationKey,
				descriptor,
				metadataFile: filePath,
				matchedField: "key",
			};
		}

		const candidateFields = ["citationkey", "zotero_id", "id"];
		for (const fieldKey of candidateFields) {
			const fieldValue = parsed.fields[fieldKey];
			if (typeof fieldValue === "string" && normalizeKey(fieldValue) === normalizedTarget) {
				return {
					success: true,
					source: "bib",
					entry: parsed,
					rawEntry: parsed.rawEntry || "",
					matchType: "citationKey",
					matchValue: fieldValue,
					descriptor,
					metadataFile: filePath,
					matchedField: fieldKey,
				};
			}
		}
	}

	return null;
};

export const lookupBibliographyMetadataByPath = async (
	finderPath: string,
	options: BibliographyLookupOptions = {},
): Promise<BibliographyMetadataMatch | { success: false; errors: string[] }> => {
	const errors: string[] = [];
	const jsonPath = options.jsonPath ?? process.env.BIBLIOGRAPHY_JSON ?? null;
	const bibPath = options.bibPath ?? process.env.BIBLIOGRAPHY_BIB ?? null;
	let attempted = false;

	if (jsonPath) {
		attempted = true;
		if (await fileExists(jsonPath)) {
			const jsonMatch = await lookupInJson(finderPath, jsonPath);
			if (jsonMatch) {
				return jsonMatch;
			}
			errors.push(`No matching entry found in JSON metadata at ${jsonPath}`);
		} else {
			errors.push(`JSON metadata file not found at ${jsonPath}`);
		}
	}

	if (bibPath) {
		attempted = true;
		if (await fileExists(bibPath)) {
			const bibMatch = await lookupInBib(finderPath, bibPath);
			if (bibMatch) {
				return bibMatch;
			}
			errors.push(`No matching entry found in BibTeX metadata at ${bibPath}`);
		} else {
			errors.push(`BibTeX metadata file not found at ${bibPath}`);
		}
	}

	if (!attempted) {
		errors.push(
			"No Bibliography metadata files configured. Provide BIBLIOGRAPHY_JSON or BIBLIOGRAPHY_BIB, or call lookupBibliographyMetadataByPath with explicit paths.",
		);
	}

	return { success: false, errors };
};

export const lookupBibliographyMetadataByCitationKey = async (
	citationKey: string,
	options: BibliographyLookupOptions = {},
): Promise<BibliographyMetadataMatch | { success: false; errors: string[] }> => {
	const trimmedKey = citationKey.trim();
	if (!trimmedKey) {
		return {
			success: false,
			errors: ["Citation key must not be empty"],
		};
	}

	const errors: string[] = [];
	const jsonPath = options.jsonPath ?? process.env.BIBLIOGRAPHY_JSON ?? null;
	const bibPath = options.bibPath ?? process.env.BIBLIOGRAPHY_BIB ?? null;
	let attempted = false;

	if (jsonPath) {
		attempted = true;
		if (await fileExists(jsonPath)) {
			const jsonMatch = await lookupCitationInJson(trimmedKey, jsonPath);
			if (jsonMatch) {
				return jsonMatch;
			}
			errors.push(
				`No entry with citation key '${trimmedKey}' in JSON metadata at ${jsonPath}`,
			);
		} else {
			errors.push(`JSON metadata file not found at ${jsonPath}`);
		}
	}

	if (bibPath) {
		attempted = true;
		if (await fileExists(bibPath)) {
			const bibMatch = await lookupCitationInBib(trimmedKey, bibPath);
			if (bibMatch) {
				return bibMatch;
			}
			errors.push(
				`No entry with citation key '${trimmedKey}' in BibTeX metadata at ${bibPath}`,
			);
		} else {
			errors.push(`BibTeX metadata file not found at ${bibPath}`);
		}
	}

	if (!attempted) {
		errors.push(
			"No Bibliography metadata files configured. Provide BIBLIOGRAPHY_JSON or BIBLIOGRAPHY_BIB, or call lookupBibliographyMetadataByCitationKey with explicit paths.",
		);
	}

	return { success: false, errors };
};

export const clearBibliographyMetadataCache = (): void => {
	CACHE.json.clear();
	CACHE.bib.clear();
};
