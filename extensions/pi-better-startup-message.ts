import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const EXTENSION_KEY = "pi-better-startup-message";

type JsonObject = Record<string, any>;

interface ProjectStatus {
	vcs: "jj" | "git";
	root: string;
	lines: string[];
}

interface StartupSummary {
	skills: string[];
	extensions: string[];
	prompts: string[];
	localExtensions: string[];
	projectStatus?: ProjectStatus;
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

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function run(cwd: string, command: string, args: string[]): string | undefined {
	try {
		return stripAnsi(execFileSync(command, args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1500,
			env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
		}).trim());
	} catch {
		return undefined;
	}
}

function shortRoot(root: string): string {
	return basename(root) || root;
}

function detectJjStatus(cwd: string): ProjectStatus | undefined {
	const root = run(cwd, "jj", ["root"]);
	if (!root) return undefined;
	const log = run(cwd, "jj", ["log", "--no-pager", "-n", "4", "--color", "never"]);
	const lines = [`jj ${shortRoot(root)}`, ...(log ? log.split("\n").filter(Boolean).slice(0, 9) : ["(no jj log output)"])];
	return { vcs: "jj", root, lines };
}

function detectGitStatus(cwd: string): ProjectStatus | undefined {
	const root = run(cwd, "git", ["rev-parse", "--show-toplevel"]);
	if (!root) return undefined;
	const branch = run(cwd, "git", ["branch", "--show-current"]) || run(cwd, "git", ["rev-parse", "--short", "HEAD"]) || "unknown";
	const status = (run(cwd, "git", ["status", "--short"]) || "").split("\n").filter(Boolean);
	const changes = status.length === 0 ? "clean" : `${status.length} changed`;
	const commits = (run(cwd, "git", ["log", "--oneline", "--decorate", "-n", "4"]) || "").split("\n").filter(Boolean);
	const visibleStatus = status.slice(0, 3).map((line) => `± ${line}`);
	if (status.length > visibleStatus.length) visibleStatus.push(`± … ${status.length - visibleStatus.length} more changes`);
	const lines = [`git ${branch} · ${changes}`, ...visibleStatus, ...commits.map((line) => `● ${line}`)];
	return { vcs: "git", root, lines };
}

function detectProjectStatus(ctx: ExtensionContext): ProjectStatus | undefined {
	return detectJjStatus(ctx.cwd) ?? detectGitStatus(ctx.cwd);
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
		projectStatus: detectProjectStatus(ctx),
	};
}

function renderSection(lines: string[], width: number, title: string, items: string[], color: (s: string) => string, dim: (s: string) => string) {
	if (items.length === 0) return;
	if (lines.length > 0) lines.push("");
	lines.push(truncateToWidth(color(`${title} (${items.length})`), width));
	for (const item of items) {
		lines.push(truncateToWidth(dim(`  • ${item}`), width));
	}
}

function renderTurtle(theme: Theme): string[] {
	const y = (s: string) => theme.fg("warning", s);
	const g = (s: string) => theme.fg("success", s);
	const h = (s: string) => theme.fg("accent", s);
	return [
		" " + y("▗") + g("█████") + y("▖"),
		y("▐") + g("███████") + y("▌"),
		h("▝▀▘") + " " + h("▀") + " " + h("▝▀▘"),
	];
}

function divider(theme: Theme, width: number, label?: string): string {
	const cappedWidth = Math.max(12, Math.min(width, 96));
	if (!label) return theme.fg("dim", "─".repeat(cappedWidth));
	const title = ` ${label} `;
	const left = 1;
	const right = Math.max(1, cappedWidth - left - title.length);
	return theme.fg("dim", "─".repeat(left) + title + "─".repeat(right));
}

function renderProjectStatus(lines: string[], status: ProjectStatus | undefined, theme: Theme, width: number): void {
	if (!status) return;
	lines.push(divider(theme, width, "project"));
	status.lines.forEach((line, index) => {
		const text = `  ${line}`;
		const rendered = index === 0
			? theme.fg("mdHeading", text)
			: line.startsWith("±")
				? theme.fg("warning", text)
				: line.startsWith("@")
					? theme.fg("accent", text)
					: theme.fg("dim", text);
		lines.push(truncateToWidth(rendered, width));
	});
	lines.push(divider(theme, width));
}

function renderSummary(summary: StartupSummary, theme: Theme, width: number): string[] {
	const lines: string[] = [...renderTurtle(theme), ""];
	renderProjectStatus(lines, summary.projectStatus, theme, width);
	renderSection(lines, width, "Skills", summary.skills, (s) => theme.fg("mdHeading", s), (s) => theme.fg("dim", s));
	renderSection(lines, width, "Prompts", summary.prompts, (s) => theme.fg("mdHeading", s), (s) => theme.fg("dim", s));
	renderSection(lines, width, "Extensions", summary.extensions, (s) => theme.fg("mdHeading", s), (s) => theme.fg("dim", s));
	renderSection(lines, width, "Local extensions", summary.localExtensions, (s) => theme.fg("mdHeading", s), (s) => theme.fg("dim", s));
	if (summary.skills.length + summary.prompts.length + summary.extensions.length + summary.localExtensions.length === 0) {
		lines.push(truncateToWidth(theme.fg("dim", "  No startup resources found."), width));
	}
	return lines;
}

function plainSection(lines: string[], title: string, items: string[]): void {
	if (items.length === 0) return;
	if (lines.length > 0) lines.push("");
	lines.push(`${title} (${items.length})`);
	for (const item of items) lines.push(`  • ${item}`);
}

function plainProjectStatus(lines: string[], status: ProjectStatus | undefined): void {
	if (!status) return;
	lines.push("─ project ─");
	for (const line of status.lines) lines.push(`  ${line}`);
	lines.push("───────────");
}

function plainSummary(summary: StartupSummary): string {
	const lines: string[] = [];
	plainProjectStatus(lines, summary.projectStatus);
	plainSection(lines, "Skills", summary.skills);
	plainSection(lines, "Prompts", summary.prompts);
	plainSection(lines, "Extensions", summary.extensions);
	plainSection(lines, "Local extensions", summary.localExtensions);
	if (summary.skills.length + summary.prompts.length + summary.extensions.length + summary.localExtensions.length === 0) {
		lines.push("  No startup resources found.");
	}
	return lines.join("\n");
}

function isStartupSummary(value: unknown): value is StartupSummary {
	return Boolean(
		value &&
		typeof value === "object" &&
		Array.isArray((value as StartupSummary).skills) &&
		Array.isArray((value as StartupSummary).extensions) &&
		Array.isArray((value as StartupSummary).prompts) &&
		Array.isArray((value as StartupSummary).localExtensions),
	);
}

function sendStartupMessage(pi: ExtensionAPI, ctx: ExtensionContext, force = false): void {
	if (!force && !isQuietStartupEnabled(ctx)) return;

	const summary = buildSummary(pi, ctx);
	pi.sendMessage<StartupSummary>({
		customType: EXTENSION_KEY,
		content: plainSummary(summary),
		display: true,
		details: summary,
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer<StartupSummary>(EXTENSION_KEY, (message, _options, theme) => ({
		render(width: number): string[] {
			if (isStartupSummary(message.details)) return renderSummary(message.details, theme, width);
			const content = typeof message.content === "string" ? message.content : "";
			return content.split("\n").map((line) => truncateToWidth(theme.fg("dim", line), width));
		},
		invalidate() {},
	}));

	pi.on("session_start", (event, ctx) => {
		if (event.reason === "startup") sendStartupMessage(pi, ctx);
	});

	pi.registerCommand("better-startup", {
		description: "Append the cleaner startup resource summary to chat history",
		handler: async (_args, ctx) => {
			sendStartupMessage(pi, ctx, true);
		},
	});
}
