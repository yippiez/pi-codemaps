import { spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

type CodemapRelationType = "relevance" | "calls" | "dependency" | "called-by" | string;

interface CodemapRelationItem {
	type: CodemapRelationType;
	symbol: string;
	text: string;
	target?: string;
	notes?: string;
}

interface CodemapFileItem {
	id: string;
	label: string;
	path: string;
	items: CodemapRelationItem[];
}

interface CodemapDocument {
	title: string;
	prompt: string;
	createdAt: string;
	files: CodemapFileItem[];
}

interface SavedCodemapEntry {
	filename: string;
	absolutePath: string;
	title: string;
	prompt: string;
	createdAt: string;
}

interface LegacyCodemapRef {
	path?: unknown;
	claim?: unknown;
	symbol?: unknown;
}

type ListAction =
	| { type: "back"; selectedIndex: number }
	| { type: "refresh"; selectedIndex: number; absolutePath: string }
	| { type: "open"; selectedIndex: number; absolutePath: string };

type ViewAction =
	| { type: "back"; selectedIndex: number; collapsedFileIds: string[] }
	| { type: "regenerate"; selectedIndex: number; collapsedFileIds: string[] }
	| { type: "open"; selectedIndex: number; collapsedFileIds: string[]; file: CodemapFileItem };

type CodemapViewResult =
	| { type: "back" }
	| { type: "refresh"; prompt: string; absolutePath: string };

type RelationSymbolSpacing = Record<string, number>;
type ThemeBackgroundKey = "selectedBg" | "customMessageBg" | "userMessageBg";
type ThemeForegroundKey = "accent" | "success" | "warning" | "error" | "muted" | "dim";
type AnsiColorCode = "31" | "33" | "36" | "37";

const DEFAULT_RELATION_SYMBOLS: Record<string, string> = {
	relevance: "=>",
	calls: "->",
	dependency: "⫘",
	"called-by": "<-",
};

const RELATION_SYMBOL_SPACING: RelationSymbolSpacing = {
	"=>": 1,
	"->": 1,
	"⫘": 2,
	"<-": 1,
};

function codeMapsDir(cwd: string): string {
	return join(cwd, ".pi", "codemaps");
}

function toWorkspaceRelativePath(cwd: string, filePath: string): string {
	return filePath.startsWith(`${cwd}/`) ? filePath.slice(cwd.length + 1) : filePath;
}

function getRelationDisplayLabel(type: string): string {
	return type.trim().length > 0 ? type.replaceAll("-", " ") : "note";
}

function getRelationSymbolSpacing(symbol: string): number {
	return RELATION_SYMBOL_SPACING[symbol] ?? 1;
}

function getDefaultRelationSymbol(type: string): string {
	return DEFAULT_RELATION_SYMBOLS[type] ?? "•";
}

function basenameLabel(filePath: string): string {
	const normalized = filePath.replaceAll("\\", "/");
	const basename = normalized.split("/").pop();
	return basename && basename.length > 0 ? basename : normalized;
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug.length > 0 ? slug : "codemap";
}

function makeCodemapFilename(prompt: string, now: Date = new Date()): string {
	const stamp = now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
	return `${slugify(prompt)}-${stamp}.json`;
}

function shellEscape(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function clampIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.max(0, Math.min(index, length - 1));
}

function wrapIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return ((index % length) + length) % length;
}

function fillToWidth(line: string, width: number): string {
	const truncated = truncateToWidth(line, width);
	const remaining = Math.max(0, width - visibleWidth(truncated));
	return truncated + " ".repeat(remaining);
}

function withBackground(theme: Theme, key: ThemeBackgroundKey, line: string, width: number): string {
	const padded = fillToWidth(line, width);
	try {
		return theme.bg(key, padded);
	} catch {
		return padded;
	}
}

function withForeground(theme: Theme, key: ThemeForegroundKey, text: string): string {
	try {
		return theme.fg(key, text);
	} catch {
		return text;
	}
}

function withAnsiColor(text: string, color: AnsiColorCode, bold = false): string {
	const prefix = bold ? `\x1b[1;${color}m` : `\x1b[${color}m`;
	return `${prefix}${text}\x1b[0m`;
}

function getRelationTypeColor(type: string): AnsiColorCode {
	switch (type) {
		case "relevance":
			return "31";
		case "calls":
			return "33";
		case "dependency":
			return "36";
		case "called-by":
			return "31";
		default:
			return "37";
	}
}

function renderStyledInline(theme: Theme, text: string, baseColor: ThemeForegroundKey = "muted"): string {
	const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:\:\d+)?)/g;
	let result = "";
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(text)) !== null) {
		const start = match.index;
		const token = match[0] ?? "";
		if (start > lastIndex) {
			result += withForeground(theme, baseColor, text.slice(lastIndex, start));
		}

		if (token.startsWith("`") && token.endsWith("`")) {
			const inner = token.slice(1, -1);
			result += withForeground(theme, "accent", inner);
		} else if (token.startsWith("**") && token.endsWith("**")) {
			const inner = token.slice(2, -2);
			result += withForeground(theme, "accent", inner);
		} else if (token.startsWith("*") && token.endsWith("*")) {
			const inner = token.slice(1, -1);
			result += withForeground(theme, "muted", theme.italic(inner));
		} else {
			result += withForeground(theme, "accent", theme.underline(token));
		}

		lastIndex = start + token.length;
	}

	if (lastIndex < text.length) {
		result += withForeground(theme, baseColor, text.slice(lastIndex));
	}

	return result.length > 0 ? result : withForeground(theme, baseColor, text);
}

function makeDivider(theme: Theme, width: number): string {
	return truncateToWidth(theme.fg("borderMuted", "─".repeat(Math.max(1, width))), width);
}

function cleanTarget(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRelationItem(value: unknown): CodemapRelationItem | null {
	if (!isRecord(value)) return null;
	const rawType = typeof value.type === "string" ? value.type.trim() : "";
	const rawText = typeof value.text === "string" ? value.text.trim() : "";
	if (rawType.length === 0 || rawText.length === 0) return null;
	const symbol =
		typeof value.symbol === "string" && value.symbol.trim().length > 0
			? value.symbol.trim()
			: getDefaultRelationSymbol(rawType);

	return {
		type: rawType,
		symbol,
		text: rawText,
		target: cleanTarget(value.target),
		notes: cleanTarget(value.notes),
	};
}

function normalizeFileItem(value: unknown): CodemapFileItem | null {
	if (!isRecord(value)) return null;
	const path = typeof value.path === "string" ? value.path.trim() : "";
	if (path.length === 0) return null;
	const id =
		typeof value.id === "string" && value.id.trim().length > 0 ? value.id.trim() : path;
	const label =
		typeof value.label === "string" && value.label.trim().length > 0 ? value.label.trim() : basenameLabel(path);
	const rawItems = Array.isArray(value.items) ? value.items : [];
	const items = rawItems.map(normalizeRelationItem).filter((item): item is CodemapRelationItem => item !== null);

	return {
		id,
		label,
		path,
		items,
	};
}

function normalizeCodemapDocument(value: unknown, fallbackTitle: string): CodemapDocument | null {
	if (!isRecord(value)) return null;
	const title =
		typeof value.title === "string" && value.title.trim().length > 0 ? value.title.trim() : fallbackTitle;
	const prompt = typeof value.prompt === "string" && value.prompt.trim().length > 0 ? value.prompt.trim() : "";
	const createdAt =
		typeof value.createdAt === "string" && value.createdAt.trim().length > 0
			? value.createdAt
			: new Date().toISOString();
	const rawFiles = Array.isArray(value.files) ? value.files : [];
	const files = rawFiles.map(normalizeFileItem).filter((item): item is CodemapFileItem => item !== null);
	if (prompt.length === 0) return null;

	return {
		title,
		prompt,
		createdAt,
		files,
	};
}

function normalizeLegacyCodemapDocument(value: unknown, fallbackTitle: string): CodemapDocument | null {
	if (!isRecord(value)) return null;
	const prompt =
		typeof value.prompt === "string" && value.prompt.trim().length > 0
			? value.prompt.trim()
			: typeof value.question === "string" && value.question.trim().length > 0
				? value.question.trim()
				: "";
	if (prompt.length === 0) return null;

	const createdAt =
		typeof value.createdAt === "string" && value.createdAt.trim().length > 0
			? value.createdAt
			: new Date().toISOString();
	const rawCodemap = isRecord(value.codemap) ? value.codemap : value;
	const title =
		typeof rawCodemap.title === "string" && rawCodemap.title.trim().length > 0
			? rawCodemap.title.trim()
			: fallbackTitle;
	const refs = Array.isArray(rawCodemap.refs) ? rawCodemap.refs : [];
	const filesByPath = new Map<string, CodemapFileItem>();

	for (const ref of refs) {
		const entry = isRecord(ref) ? (ref as LegacyCodemapRef) : null;
		const path = typeof entry?.path === "string" ? entry.path.trim() : "";
		const claim = typeof entry?.claim === "string" ? entry.claim.trim() : "";
		if (path.length === 0 || claim.length === 0) continue;
		let file = filesByPath.get(path);
		if (!file) {
			file = {
				id: path,
				label: basenameLabel(path),
				path,
				items: [],
			};
			filesByPath.set(path, file);
		}
		file.items.push({
			type: "relevance",
			symbol: "=>",
			text: claim,
			target: typeof entry?.symbol === "string" && entry.symbol.trim().length > 0 ? entry.symbol.trim() : undefined,
		});
	}

	return {
		title,
		prompt,
		createdAt,
		files: [...filesByPath.values()],
	};
}

async function readCodemapDocument(absolutePath: string): Promise<CodemapDocument> {
	const raw = await readFile(absolutePath, "utf-8");
	const parsed = JSON.parse(raw) as unknown;
	const fallbackTitle = basenameLabel(absolutePath);
	const normalized = normalizeCodemapDocument(parsed, fallbackTitle) ?? normalizeLegacyCodemapDocument(parsed, fallbackTitle);
	if (!normalized) {
		throw new Error(`Invalid codemap: ${absolutePath}`);
	}
	return normalized;
}

async function listSavedCodemaps(cwd: string): Promise<SavedCodemapEntry[]> {
	const dir = codeMapsDir(cwd);
	await mkdir(dir, { recursive: true });
	const files = (await readdir(dir).catch(() => [])).filter((entry) => entry.endsWith(".json"));
	const entries: SavedCodemapEntry[] = [];

	for (const filename of files) {
		const absolutePath = join(dir, filename);
		try {
			const doc = await readCodemapDocument(absolutePath);
			entries.push({
				filename,
				absolutePath,
				title: doc.title,
				prompt: doc.prompt,
				createdAt: doc.createdAt,
			});
		} catch {
			// Invalid files stay hidden from the list instead of crashing the screen.
		}
	}

	entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return entries;
}

function renderListRow(theme: Theme, entry: SavedCodemapEntry, selected: boolean, width: number): string[] {
	const titlePrefix = selected ? theme.fg("warning", "▶ ") : "  ";
	const titleText = `${titlePrefix}${entry.title}`;
	const previewPrefix = selected ? "  " : "  ";
	const previewText = `${previewPrefix}${entry.prompt}`;
	const titleLine = selected
		? withBackground(theme, "selectedBg", theme.bold(titleText), width)
		: truncateToWidth(theme.fg("accent", titleText), width);
	const previewLine = selected
		? withBackground(theme, "selectedBg", theme.fg("muted", previewText), width)
		: truncateToWidth(theme.fg("muted", previewText), width);
	return [titleLine, previewLine];
}

class CodemapListScreen {
	private readonly tuiRows: () => number;
	private readonly theme: Theme;
	private readonly done: (action: ListAction) => void;
	private entries: SavedCodemapEntry[];
	private selectedIndex: number;
	private scrollIndex = 0;

	constructor(
		entries: SavedCodemapEntry[],
		theme: Theme,
		tuiRows: () => number,
		initialIndex: number,
		done: (action: ListAction) => void,
	) {
		this.entries = entries;
		this.theme = theme;
		this.tuiRows = tuiRows;
		this.selectedIndex = clampIndex(initialIndex, entries.length);
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.done({ type: "back", selectedIndex: this.selectedIndex });
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.selectedIndex = wrapIndex(this.selectedIndex - 1, this.entries.length);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.selectedIndex = wrapIndex(this.selectedIndex + 1, this.entries.length);
			return;
		}
		if (data === "r") {
			const selected = this.entries[this.selectedIndex];
			if (!selected) return;
			this.done({ type: "refresh", selectedIndex: this.selectedIndex, absolutePath: selected.absolutePath });
			return;
		}
		if ((matchesKey(data, "enter") || matchesKey(data, "return")) && this.entries.length > 0) {
			const selected = this.entries[this.selectedIndex];
			if (!selected) return;
			this.done({
				type: "open",
				selectedIndex: this.selectedIndex,
				absolutePath: selected.absolutePath,
			});
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const w = Math.max(24, width);
		const lines: string[] = [];
		const totalRows = Math.max(12, this.tuiRows());
		const headerHeight = 4;
		const footerHeight = 2;
		const bodyHeight = Math.max(2, totalRows - headerHeight - footerHeight);
		const rowsPerEntry = 2;
		const visibleEntries = Math.max(1, Math.floor(bodyHeight / rowsPerEntry));
		if (this.selectedIndex < this.scrollIndex) {
			this.scrollIndex = this.selectedIndex;
		}
		if (this.selectedIndex >= this.scrollIndex + visibleEntries) {
			this.scrollIndex = this.selectedIndex - visibleEntries + 1;
		}

		lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold("Codemaps")), w));
		lines.push(truncateToWidth(this.theme.fg("muted", `${this.entries.length} saved codemap${this.entries.length === 1 ? "" : "s"}`), w));
		lines.push(makeDivider(this.theme, w));

		const endIndex = Math.min(this.entries.length, this.scrollIndex + visibleEntries);
		for (let index = this.scrollIndex; index < endIndex; index++) {
			const entry = this.entries[index];
			if (!entry) continue;
			lines.push(...renderListRow(this.theme, entry, index === this.selectedIndex, w));
		}

		while (lines.length < totalRows - footerHeight) {
			lines.push("");
		}

		lines.push(makeDivider(this.theme, w));
		lines.push(truncateToWidth(this.theme.fg("dim", "enter open  r refresh selected  q back"), w));
		return lines.slice(0, totalRows);
	}
}

function renderRelationLines(theme: Theme, item: CodemapRelationItem, width: number): string[] {
	const relationColor = getRelationTypeColor(item.type);
	const symbol = withAnsiColor(item.symbol, relationColor, true);
	const target = item.target ? ` (${item.target})` : "";
	const text = `   ${symbol}${" ".repeat(getRelationSymbolSpacing(item.symbol))}${renderStyledInline(theme, item.text)}${renderStyledInline(theme, target, "dim")}`;
	const wrapped = wrapTextWithAnsi(text, Math.max(12, width));
	const lines = wrapped.length > 0 ? wrapped : [text];

	if (item.notes) {
		lines.push(
			...wrapTextWithAnsi(
				`${withForeground(theme, "dim", "      note: ")}${renderStyledInline(theme, item.notes, "dim")}`,
				Math.max(12, width),
			),
		);
	}
	return lines.map((line) => truncateToWidth(line, width));
}

function renderFileRow(theme: Theme, file: CodemapFileItem, selected: boolean, expanded: boolean, width: number): string {
	const indicator = withForeground(theme, expanded ? "warning" : "muted", expanded ? "▾" : "▸");
	const label = withForeground(theme, "success", theme.bold(`[${file.label}]`));
	const filePath = withForeground(theme, "dim", theme.italic(file.path));
	const content = `${indicator} ${label} ${filePath}`;
	const styled = selected ? theme.bold(content) : content;
	return withBackground(theme, selected ? "selectedBg" : "customMessageBg", styled, width);
}

class CodemapViewScreen {
	private readonly tuiRows: () => number;
	private readonly theme: Theme;
	private readonly done: (action: ViewAction) => void;
	private readonly absolutePath: string;
	private readonly document: CodemapDocument;
	private selectedIndex: number;
	private readonly collapsedFileIds: Set<string>;
	private scrollLine = 0;

	constructor(
		document: CodemapDocument,
		absolutePath: string,
		theme: Theme,
		tuiRows: () => number,
		initialIndex: number,
		collapsedFileIds: Iterable<string>,
		done: (action: ViewAction) => void,
	) {
		this.document = document;
		this.absolutePath = absolutePath;
		this.theme = theme;
		this.tuiRows = tuiRows;
		this.selectedIndex = clampIndex(initialIndex, document.files.length);
		this.collapsedFileIds = new Set(collapsedFileIds);
		this.done = done;
	}

	private snapshotBase(): { selectedIndex: number; collapsedFileIds: string[] } {
		return {
			selectedIndex: this.selectedIndex,
			collapsedFileIds: [...this.collapsedFileIds],
		};
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.done({ type: "back", ...this.snapshotBase() });
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.selectedIndex = wrapIndex(this.selectedIndex - 1, this.document.files.length);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.selectedIndex = wrapIndex(this.selectedIndex + 1, this.document.files.length);
			return;
		}
		if (data === " ") {
			const selectedFile = this.document.files[this.selectedIndex];
			if (!selectedFile) return;
			if (this.collapsedFileIds.has(selectedFile.id)) {
				this.collapsedFileIds.delete(selectedFile.id);
			} else {
				this.collapsedFileIds.add(selectedFile.id);
			}
			return;
		}
		if (data === "r") {
			this.done({ type: "regenerate", ...this.snapshotBase() });
			return;
		}
		if ((matchesKey(data, "enter") || matchesKey(data, "return")) && this.document.files.length > 0) {
			const file = this.document.files[this.selectedIndex];
			if (!file) return;
			this.done({
				type: "open",
				file,
				...this.snapshotBase(),
			});
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const w = Math.max(32, width);
		const totalRows = Math.max(16, this.tuiRows());
		const lines: string[] = [];
		lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold(this.document.title)), w));
		lines.push(...wrapTextWithAnsi(this.theme.fg("muted", `Prompt: ${this.document.prompt}`), Math.max(16, w)));
		lines.push(truncateToWidth(this.theme.fg("dim", `File: ${this.absolutePath}`), w));
		lines.push(makeDivider(this.theme, w));

		const headerHeight = lines.length;
		const footerHeight = 2;
		const bodyHeight = Math.max(4, totalRows - headerHeight - footerHeight);
		const bodyLines: string[] = [];
		const fileTopLines = new Map<number, number>();

		for (let index = 0; index < this.document.files.length; index++) {
			const file = this.document.files[index];
			if (!file) continue;
			fileTopLines.set(index, bodyLines.length);
			const expanded = !this.collapsedFileIds.has(file.id);
			bodyLines.push(renderFileRow(this.theme, file, index === this.selectedIndex, expanded, w));
			if (!expanded) continue;
			if (file.items.length === 0) {
				bodyLines.push(truncateToWidth(this.theme.fg("dim", "   no relation items"), w));
				continue;
			}
			for (const item of file.items) {
				bodyLines.push(...renderRelationLines(this.theme, item, w));
			}
		}

		const selectedTop = fileTopLines.get(this.selectedIndex) ?? 0;
		if (selectedTop < this.scrollLine) {
			this.scrollLine = selectedTop;
		}
		if (selectedTop >= this.scrollLine + bodyHeight) {
			this.scrollLine = selectedTop - bodyHeight + 1;
		}

		const visibleBody = bodyLines.slice(this.scrollLine, this.scrollLine + bodyHeight);
		lines.push(...visibleBody);
		while (lines.length < totalRows - footerHeight) {
			lines.push("");
		}

		lines.push(makeDivider(this.theme, w));
		lines.push(truncateToWidth(this.theme.fg("dim", "enter open file  space collapse  r regenerate  q back"), w));
		return lines.slice(0, totalRows);
	}
}

async function openFileInEditor(ctx: ExtensionCommandContext, file: CodemapFileItem): Promise<void> {
	const editor = process.env.EDITOR;
	if (!editor || editor.trim().length === 0) {
		ctx.ui.notify("EDITOR is not set", "error");
		return;
	}

	const filePath = isAbsolute(file.path) ? file.path : join(ctx.cwd, file.path);
	const command = `${editor} ${shellEscape(filePath)}`;
	const result = spawnSync("sh", ["-lc", command], {
		cwd: ctx.cwd,
		stdio: "inherit",
	});
	if ((result.status ?? 1) !== 0) {
		ctx.ui.notify(`Failed to open editor (${result.status ?? "unknown"})`, "error");
	}
}

function buildCodemapPrompt(userPrompt: string, outputPath: string, overwrite: boolean): string {
	const taskLine = overwrite
		? `Refresh the outdated codemap at ${outputPath}.`
		: `Create a codemap at ${outputPath}.`;
	const pathRule = overwrite
		? "- Read the existing codemap first, then overwrite that exact file."
		: "- Create the codemap at that exact file path.";
	return `Task: ${taskLine}

Request: ${userPrompt}

Requirements:
- Investigate the repository with read/grep/find/bash tools before writing.
- Do not edit repository source files.
- ${pathRule}
- Write exactly one JSON file and do not create any additional codemap files.
- Update outdated codemap information so the saved analysis reflects the current repository.
- Return exactly: Saved codemap: ${outputPath}

JSON shape:
{
  "title": string,
  "prompt": string,
  "createdAt": ISO-8601 string,
  "files": [
    {
      "id": string,
      "label": string,
      "path": string,
      "items": [
        {
          "type": "relevance" | "calls" | "dependency" | string,
          "symbol": string,
          "text": string,
          "target"?: string,
          "notes"?: string
        }
      ]
    }
  ]
}

Codemap rules:
- Answer the request directly, not a generic summary.
- Keep the file list focused and compact.
- Use basename-only labels and repository-relative paths.
- Keep each item precise, short, and high-signal.
- Prefer 3-8 files unless the request clearly needs more.

No markdown fences. No extra prose.`;
}

async function waitForCodemapAtPath(absolutePath: string, baselineMtimeMs: number | null): Promise<void> {
	const timeoutAt = Date.now() + 4000;
	while (Date.now() < timeoutAt) {
		try {
			const fileStat = await stat(absolutePath);
			if (baselineMtimeMs === null || fileStat.mtimeMs > baselineMtimeMs) {
				return;
			}
		} catch {
			// wait for file creation
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

async function runCodemapGeneration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	userPrompt: string,
	outputPath: string,
	overwrite: boolean,
): Promise<CodemapDocument> {
	const absolutePath = isAbsolute(outputPath) ? outputPath : join(ctx.cwd, outputPath);
	let baselineMtimeMs: number | null = null;
	try {
		baselineMtimeMs = (await stat(absolutePath)).mtimeMs;
	} catch {
		baselineMtimeMs = null;
	}

	ctx.ui.setWorkingMessage(overwrite ? "Regenerating codemap..." : "Creating codemap...");
	try {
		const prompt = buildCodemapPrompt(userPrompt, outputPath, overwrite);
		pi.sendUserMessage(prompt);
		await ctx.waitForIdle();
		await waitForCodemapAtPath(absolutePath, baselineMtimeMs);
		return await readCodemapDocument(absolutePath);
	} finally {
		ctx.ui.setWorkingMessage();
	}
}

async function showCodemapList(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/codemap:list requires interactive mode", "error");
		return;
	}

	let entries = await listSavedCodemaps(ctx.cwd);
	if (entries.length === 0) {
		ctx.ui.notify("No codemaps yet. Use /codemap:create first.", "info");
		return;
	}

	let selectedIndex = 0;
	while (true) {
		const action = await ctx.ui.custom<ListAction>((tui, theme, _keybindings, done) => {
			return new CodemapListScreen(entries, theme, () => tui.terminal.rows, selectedIndex, done);
		});

		selectedIndex = action.selectedIndex;
		if (action.type === "back") return;
		if (action.type === "refresh") {
			try {
				const document = await readCodemapDocument(action.absolutePath);
				const relativePath = toWorkspaceRelativePath(ctx.cwd, action.absolutePath);
				await runCodemapGeneration(pi, ctx, document.prompt, relativePath, true);
				ctx.ui.notify(`Codemap refreshed: ${relativePath}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to refresh codemap: ${message}`, "error");
			}
			return;
		}
		const result = await showCodemapView(ctx, action.absolutePath);
		if (result.type === "refresh") {
			try {
				const relativePath = toWorkspaceRelativePath(ctx.cwd, result.absolutePath);
				await runCodemapGeneration(pi, ctx, result.prompt, relativePath, true);
				ctx.ui.notify(`Codemap refreshed: ${relativePath}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to refresh codemap: ${message}`, "error");
			}
			return;
		}
		entries = await listSavedCodemaps(ctx.cwd);
		if (entries.length === 0) {
			ctx.ui.notify("No codemaps remain on disk.", "info");
			return;
		}
		selectedIndex = clampIndex(selectedIndex, entries.length);
	}
}

async function showCodemapView(ctx: ExtensionCommandContext, absolutePath: string): Promise<CodemapViewResult> {
	let document: CodemapDocument;
	try {
		document = await readCodemapDocument(absolutePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Failed to load codemap: ${message}`, "error");
		return { type: "back" };
	}
	let selectedIndex = 0;
	let collapsedFileIds = new Set<string>();

	while (true) {
		const action = await ctx.ui.custom<ViewAction>((tui, theme, _keybindings, done) => {
			return new CodemapViewScreen(
				document,
				absolutePath,
				theme,
				() => tui.terminal.rows,
				selectedIndex,
				collapsedFileIds,
				done,
			);
		});

		selectedIndex = clampIndex(action.selectedIndex, document.files.length);
		collapsedFileIds = new Set(action.collapsedFileIds);

		if (action.type === "back") return { type: "back" };
		if (action.type === "open") {
			await openFileInEditor(ctx, action.file);
			continue;
		}
		return { type: "refresh", prompt: document.prompt, absolutePath };
	}
}

export default function codemapsExtension(pi: ExtensionAPI) {
	pi.registerCommand("codemap:create", {
		description: "Create a codemap file in .pi/codemaps",
		handler: async (args, ctx) => {
			const userPrompt = (args ?? "").trim();
			if (!userPrompt) {
				ctx.ui.notify("Usage: /codemap:create <prompt>", "warning");
				return;
			}

			const dir = codeMapsDir(ctx.cwd);
			await mkdir(dir, { recursive: true });
			const filename = makeCodemapFilename(userPrompt);
			const relativePath = `.pi/codemaps/${filename}`;

			try {
				const doc = await runCodemapGeneration(pi, ctx, userPrompt, relativePath, false);
				ctx.ui.notify(`Saved codemap: ${relativePath}`, "info");
				ctx.ui.notify(`Created "${doc.title}"`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to create codemap: ${message}`, "error");
			}
		},
	});

	pi.registerCommand("codemap:list", {
		description: "List saved codemaps",
		handler: async (_args, ctx) => {
			await showCodemapList(pi, ctx);
		},
	});
}
