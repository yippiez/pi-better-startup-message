import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const EXTENSION_KEY = "pi-better-startup-message";

type JsonObject = Record<string, any>;

interface StartupSummary {
	skills: string[];
	extensions: string[];
	prompts: string[];
	localExtensions: string[];
}

function readJson(path: string): JsonObject {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
	} catch {
		return {};
	}
}

function mergeSettings(base: JsonObject, override: JsonObject): JsonObject {
	const out: JsonObject = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			base[key] &&
			typeof base[key] === "object" &&
			!Array.isArray(base[key])
		) {
			out[key] = mergeSettings(base[key], value);
		} else {
			out[key] = value;
		}
	}
	return out;
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function loadEffectiveSettings(ctx?: ExtensionContext): JsonObject {
	let settings = readJson(join(agentDir(), "settings.json"));
	if (ctx?.isProjectTrusted()) {
		settings = mergeSettings(settings, readJson(join(ctx.cwd, ".pi", "settings.json")));
	}
	return settings;
}

function isQuietStartupEnabled(ctx?: ExtensionContext): boolean {
	if (process.env.PI_BETTER_STARTUP_FORCE === "1") return true;
	return loadEffectiveSettings(ctx).quietStartup === true;
}

function packageSource(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string") {
		return (entry as { source: string }).source;
	}
	return undefined;
}

function stripGitSource(source: string): string {
	return source
		.replace(/^git:/, "")
		.replace(/^https:\/\/github\.com\//, "")
		.replace(/^git@github\.com:/, "")
		.replace(/\.git$/, "")
		.replace(/^github\.com\//, "");
}

function packageLabel(source: string): string {
	if (source.startsWith("git:")) return stripGitSource(source);
	if (source.startsWith("npm:")) return source.slice(4).replace(/@[^/@]+$/, "");
	return stripGitSource(source);
}

function packageDir(source: string): string | undefined {
	const dir = agentDir();
	if (source.startsWith("git:")) {
		const label = stripGitSource(source);
		if (label.includes("/")) return join(dir, "git", "github.com", label);
	}
	const npmName = source.startsWith("npm:") ? source.slice(4).replace(/@[^/@]+$/, "") : source;
	const npmPath = join(dir, "npm", "node_modules", npmName);
	if (existsSync(npmPath)) return npmPath;
	if (source.startsWith("/") || source.startsWith("~") || source.startsWith(".")) {
		return resolve(source.replace(/^~/, homedir()));
	}
	return undefined;
}

function extensionDisplayPath(relativePath: string): string {
	let label = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
	label = label.replace(/^extensions\//, "");
	label = label.replace(/\/index\.tsx?$/, "");
	return label;
}

function discoverExtensionFiles(baseDir: string, configuredPath: string): string[] {
	const absolute = resolve(baseDir, configuredPath);
	if (!existsSync(absolute)) return [configuredPath];
	const stat = statSync(absolute);
	if (stat.isFile()) return [configuredPath];
	if (!stat.isDirectory()) return [configuredPath];

	const files: string[] = [];
	for (const entry of readdirSync(absolute, { withFileTypes: true })) {
		if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
			files.push(join(configuredPath, entry.name));
		} else if (entry.isDirectory()) {
			const indexTs = join(absolute, entry.name, "index.ts");
			const indexTsx = join(absolute, entry.name, "index.tsx");
			if (existsSync(indexTs)) files.push(join(configuredPath, entry.name, "index.ts"));
			else if (existsSync(indexTsx)) files.push(join(configuredPath, entry.name, "index.tsx"));
		}
	}
	return files.length > 0 ? files : [configuredPath];
}

function packageExtensions(source: string): string[] {
	const label = packageLabel(source);
	if (label.includes("pi-better-startup-message")) return [];
	const dir = packageDir(source);
	if (!dir) return [label];
	const packageJsonPath = join(dir, "package.json");
	if (!existsSync(packageJsonPath)) return [label];
	const pkg = readJson(packageJsonPath);
	const configured = Array.isArray(pkg.pi?.extensions) ? pkg.pi.extensions : [];
	if (configured.length === 0) return [];
	return configured.flatMap((entry: unknown) => {
		if (typeof entry !== "string") return [];
		return discoverExtensionFiles(dir, entry).map((file) => `${label}:${extensionDisplayPath(file)}`);
	});
}

function compactUnique(items: string[]): string[] {
	return [...new Set(items.map((item) => item.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function buildSummary(pi: ExtensionAPI, ctx: ExtensionContext): StartupSummary {
	const settings = loadEffectiveSettings(ctx);
	const packages = Array.isArray(settings.packages) ? settings.packages : [];
	const localExtensions = Array.isArray(settings.extensions) ? settings.extensions.filter((x: unknown) => typeof x === "string") as string[] : [];
	const commands = pi.getCommands();

	return {
		skills: compactUnique(commands.filter((c) => c.source === "skill").map((c) => c.name.replace(/^skill:/, ""))),
		prompts: compactUnique(commands.filter((c) => c.source === "prompt").map((c) => `/${c.name}`)),
		extensions: compactUnique(packages.flatMap((entry: unknown) => {
			const source = packageSource(entry);
			return source ? packageExtensions(source) : [];
		})),
		localExtensions: compactUnique(localExtensions),
	};
}

function renderSection(lines: string[], width: number, title: string, items: string[], color: (s: string) => string, dim: (s: string) => string) {
	if (items.length === 0) return;
	lines.push(truncateToWidth(color(`  ${title} (${items.length})`), width));
	for (const item of items) {
		lines.push(truncateToWidth(dim(`    • ${item}`), width));
	}
}

function installHeader(pi: ExtensionAPI, ctx: ExtensionContext, force = false): void {
	if (ctx.mode !== "tui") return;
	if (!force && !isQuietStartupEnabled(ctx)) return;

	const summary = buildSummary(pi, ctx);
	ctx.ui.setHeader((_tui, theme) => ({
		render(width: number): string[] {
			const lines: string[] = [""];
			const title = `${theme.bold(theme.fg("accent", "π startup"))} ${theme.fg("dim", "quiet resources")}`;
			lines.push(truncateToWidth(`  ${title}`, width));
			renderSection(lines, width, "Skills", summary.skills, (s) => theme.fg("mdHeading", s), (s) => theme.fg("dim", s));
			renderSection(lines, width, "Prompts", summary.prompts, (s) => theme.fg("mdHeading", s), (s) => theme.fg("dim", s));
			renderSection(lines, width, "Extensions", summary.extensions, (s) => theme.fg("mdHeading", s), (s) => theme.fg("dim", s));
			renderSection(lines, width, "Local extensions", summary.localExtensions, (s) => theme.fg("mdHeading", s), (s) => theme.fg("dim", s));
			if (summary.skills.length + summary.prompts.length + summary.extensions.length + summary.localExtensions.length === 0) {
				lines.push(truncateToWidth(theme.fg("dim", "    No startup resources found."), width));
			}
			lines.push("");
			return lines;
		},
		invalidate() {},
	}));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		installHeader(pi, ctx);
	});

	pi.registerCommand("better-startup", {
		description: "Preview the cleaner startup resource header",
		handler: async (_args, ctx) => {
			installHeader(pi, ctx, true);
		},
	});

	pi.registerCommand("better-startup:clear", {
		description: "Clear the cleaner startup resource header",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader(undefined);
		},
	});
}
