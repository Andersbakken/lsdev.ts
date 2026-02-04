import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import minimist from "minimist";

// ============================================================================
// Types and Interfaces
// ============================================================================

interface Root {
    key: string;
    name: string;
    path: string;
    source?: string;
    ignore?: boolean;
    default?: boolean;
    prompt?: string;
}

interface PathConfig {
    [key: string]: string | undefined;
}

interface StatResult {
    exists: boolean;
    isDir: boolean;
    dev?: number;
    ino?: number;
    mtime?: number;
}

type AnswerType = "source" | "path" | "name" | "all" | "rest" | "simple_name";
type MatchMode = "exact" | "regexp" | "word" | "ido";
type DisplayMode = "list" | "current" | "default" | undefined;

// ============================================================================
// Global State
// ============================================================================

let verbose = false;
let detectDefault: boolean | undefined;
let writeDefaultFile = false;
let readDevdirList = 1;
let detectRest = true;
let detectDevdirs = true;
let displayOnly: DisplayMode;
let matchOnly: MatchMode | undefined;
let answer: AnswerType | string = "path";
let cwd = process.cwd();

// Use PWD if it points to the same location (preserves symlinks)
if (process.env.PWD && process.env.PWD !== cwd) {
    try {
        const envStat = fs.statSync(process.env.PWD);
        const cwdStat = fs.statSync(cwd);
        if (envStat.dev === cwdStat.dev && envStat.ino === cwdStat.ino) {
            cwd = process.env.PWD;
        }
    } catch {
        // Ignore errors
    }
}

const srcPrefix = "src_";
const buildPrefix = "build_";

const matches: string[] = [];
const devRoots: Map<string, string> = new Map();
const buildRoots: string[] = [];
const roots: Map<string, Root> = new Map();
const pathConfigs: Map<string, PathConfig | null> = new Map();

let defaultDir: string | undefined;
let rootDir: string | undefined;

// ============================================================================
// Caching Utilities
// ============================================================================

const statCache: Map<string, StatResult> = new Map();

function cstat(file: string): StatResult {
    let result = statCache.get(file);
    if (!result) {
        try {
            const stat = fs.statSync(file);
            result = {
                exists: true,
                isDir: stat.isDirectory(),
                dev: stat.dev,
                ino: stat.ino,
                mtime: stat.mtimeMs
            };
        } catch {
            result = { exists: false, isDir: false };
        }
        statCache.set(file, result);
    }
    return result;
}

function cexists(file: string): boolean {
    return cstat(file).exists;
}

function cisdir(file: string): boolean {
    const stat = cstat(file);
    return stat.exists && stat.isDir;
}

// ============================================================================
// Logging
// ============================================================================

function display(...args: unknown[]): void {
    process.stderr.write(args.map(String).join(""));
}

// ============================================================================
// String Utilities
// ============================================================================

function trim(s: string): string {
    return s.trim();
}

// ============================================================================
// Path Utilities
// ============================================================================

const resolveLinkCache: Map<string, string | undefined> = new Map();

function resolveLinks(file: string): string | undefined {
    let result = resolveLinkCache.get(file);
    if (result === undefined && !resolveLinkCache.has(file)) {
        if (cexists(file)) {
            try {
                result = fs.realpathSync(file);
            } catch {
                result = undefined;
            }
        }
        resolveLinkCache.set(file, result);
    }
    return result;
}

const canonicalizeCache: Map<string, string> = new Map();

function canonicalize(file: string, base?: string): string {
    const cacheKey = `${base ?? ""}::${file}`;
    let result = canonicalizeCache.get(cacheKey);
    if (!result) {
        result = file;
        if (!path.isAbsolute(result) && base) {
            result = path.resolve(base, result);
        }
        result = result.replace(/\/+$/, "").replace(/\/+/g, "/");
        if (!result) {
            result = "/";
        }
        canonicalizeCache.set(cacheKey, result);
    }
    return result;
}

function expandHome(filepath: string): string {
    if (filepath.startsWith("~")) {
        return path.join(os.homedir(), filepath.slice(1));
    }
    return filepath;
}

/**
 * Expand glob patterns in a path. Supports * and ? wildcards.
 * Returns an array of matching paths (directories only).
 */
function expandGlob(pattern: string, base?: string): string[] {
    // Expand ~ first
    pattern = expandHome(pattern);

    // Make absolute if relative
    if (!path.isAbsolute(pattern) && base) {
        pattern = path.resolve(base, pattern);
    }

    // If no wildcards, just return the path if it exists
    if (!pattern.includes("*") && !pattern.includes("?")) {
        if (cisdir(pattern)) {
            return [pattern];
        }
        return [];
    }

    // Split into parts and find the first part with a wildcard
    const parts = pattern.split("/");
    let staticPart = "";
    let wildcardIndex = -1;

    for (let i = 0; i < parts.length; i++) {
        if (parts[i].includes("*") || parts[i].includes("?")) {
            wildcardIndex = i;
            break;
        }
        staticPart = staticPart ? path.join(staticPart, parts[i]) : (parts[i] || "/");
    }

    if (wildcardIndex === -1) {
        // No wildcard found (shouldn't happen given the check above)
        return cisdir(pattern) ? [pattern] : [];
    }

    // Convert wildcard pattern to regex
    const wildcardPart = parts[wildcardIndex];
    const regexPattern = wildcardPart
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")  // Escape regex special chars
        .replace(/\*/g, ".*")                    // * matches anything
        .replace(/\?/g, ".");                    // ? matches single char
    const regex = new RegExp(`^${regexPattern}$`);

    const results: string[] = [];

    // Read the static directory and match entries
    if (!cisdir(staticPart)) {
        return [];
    }

    try {
        const entries = fs.readdirSync(staticPart);
        for (const entry of entries) {
            if (entry === "." || entry === "..") continue;
            if (!regex.test(entry)) continue;

            const fullPath = path.join(staticPart, entry);
            if (!cisdir(fullPath)) continue;

            // If there are more parts after the wildcard, recurse
            if (wildcardIndex < parts.length - 1) {
                const remainingPattern = parts.slice(wildcardIndex + 1).join("/");
                const subResults = expandGlob(remainingPattern, fullPath);
                results.push(...subResults);
            } else {
                results.push(fullPath);
            }
        }
    } catch {
        // Ignore read errors
    }

    return results;
}

/**
 * Expand a path that may contain wildcards, returning all matching directories.
 * If no wildcards, returns the single path in an array (if it exists as a directory).
 */
function expandPath(pathPattern: string, base?: string): string[] {
    pathPattern = expandHome(pathPattern);
    if (!path.isAbsolute(pathPattern) && base) {
        pathPattern = path.resolve(base, pathPattern);
    }

    if (pathPattern.includes("*") || pathPattern.includes("?")) {
        return expandGlob(pathPattern, base);
    }

    return [pathPattern];
}

// ============================================================================
// Argument Parsing
// ============================================================================

function showHelp(): void {
    display("lsdev [options] [matches]\n");
    display("\n== Options ==\n");
    display("-w : Write out the selected directory to the relevant default file (for next invocation with -).\n");
    display("-m : Disable directory detection which will find any build tree that isn't referenced explicitly.\n");
    display("-r : Select the root of the selected project (rather than guessing subdirs based on current path).\n");
    display("-b : Only include the relevant source dirs and shadow dirs in the selection output.\n");
    display("-a : Force inclusion of all source and shadow dirs in the selection output.\n");
    display("-l : Just list out the selections and do not actually request selection.\n");
    display("-p : Just list out the name of the current working directories project if possible.\n");
    display("\n== Matches ==\n");
    display("If no matches are provided then it will behave as if -d has been passed, otherwise it will behave as if -a has\n");
    display("had been passed. If either are passed, then they override these assumptions\n");
    display("If - is passed then the current 'default' directory will be jumped to, which is specific to the kind of directory\n");
    display("you are currently in.\n");
    display("If @ is passed then the current 'emacs' directory will be jumped to.\n");
    display("Otherwise any other strings are matched and all must match to be included in the selection output\n");
    process.exit(0);
}

function parseOptions(args: string[]): void {
    let i = 0;
    while (i < args.length) {
        const option = trim(args[i]);
        if (option === "-w") {
            writeDefaultFile = true;
        } else if (option === "-r") {
            detectRest = false;
        } else if (option === "-c") {
            i++;
            cwd = args[i];
        } else if (option === "-me") {
            matchOnly = "exact";
        } else if (option === "-mr") {
            matchOnly = "regexp";
        } else if (option === "-mw") {
            matchOnly = "word";
        } else if (option === "-mi") {
            matchOnly = "ido";
        } else if (option === "-m" && args[i + 1] && !args[i + 1].startsWith("-")) {
            i++;
            matchOnly = args[i] as MatchMode;
        } else if (option === "-d") {
            detectDefault = true;
        } else if (option === "-b") {
            readDevdirList = -1;
        } else if (option === "-tS") {
            answer = "source";
        } else if (option === "-tp") {
            answer = "path";
        } else if (option === "-tn") {
            answer = "name";
        } else if (option === "-ta") {
            answer = "all";
        } else if (option === "-tr") {
            answer = "rest";
        } else if (option === "-ts") {
            answer = "simple_name";
        } else if (option === "-t" && args[i + 1]) {
            i++;
            answer = args[i];
        } else if (option === "-a") {
            readDevdirList = 2;
        } else if (option === "-m") {
            detectDevdirs = false;
        } else if (option === "-l") {
            displayOnly = "list";
        } else if (option === "-p") {
            displayOnly = "current";
        } else if (option === "-h") {
            showHelp();
        } else if (option === "-v") {
            verbose = true;
        } else if (option && !option.startsWith("-")) {
            matches.push(option);
        }
        i++;
    }
}

// Parse LSDEV_FLAGS environment variable
if (process.env.LSDEV_FLAGS) {
    parseOptions(process.env.LSDEV_FLAGS.split(/\s+/));
}

// Parse command line arguments
const argv = minimist(process.argv.slice(2), {
    boolean: ["w", "r", "d", "b", "a", "l", "p", "h", "v"],
    string: ["c", "m", "t"],
    alias: {
        me: "exact",
        mr: "regexp",
        mw: "word",
        mi: "ido",
        tS: "source",
        tp: "path",
        tn: "name",
        ta: "all",
        tr: "rest",
        ts: "simple_name"
    },
    unknown: (arg) => {
        if (!arg.startsWith("-")) {
            matches.push(arg);
            return false;
        }
        return true;
    }
});

if (argv.w) writeDefaultFile = true;
if (argv.r) detectRest = false;
if (argv.c) cwd = argv.c;
if (argv.exact) matchOnly = "exact";
if (argv.regexp) matchOnly = "regexp";
if (argv.word) matchOnly = "word";
if (argv.ido) matchOnly = "ido";
if (argv.m && typeof argv.m === "string") matchOnly = argv.m as MatchMode;
if (argv.d) detectDefault = true;
if (argv.b) readDevdirList = -1;
if (argv.source) answer = "source";
if (argv.path) answer = "path";
if (argv.name) answer = "name";
if (argv.all) answer = "all";
if (argv.rest) answer = "rest";
if (argv.simple_name) answer = "simple_name";
if (argv.t) answer = argv.t;
if (argv.a) readDevdirList = 2;
if (argv.l) displayOnly = "list";
if (argv.p) displayOnly = "current";
if (argv.h) showHelp();
if (argv.v) verbose = true;

// Add remaining arguments as matches
matches.push(...argv._);

// ============================================================================
// Config File Parsing
// ============================================================================

function parseConfig(file: string): PathConfig {
    const result: PathConfig = {};
    if (verbose) display(`ProcessingConfigFile: ${file}\n`);
    try {
        const content = fs.readFileSync(file, "utf-8");
        for (const line of content.split("\n")) {
            const trimmed = line.replace(/#.*$/, "").trim();
            const match = trimmed.match(/^(.+?)=(.*)$/);
            if (match) {
                result[match[1]] = match[2];
            }
        }
    } catch {
        // File doesn't exist or can't be read
    }
    return result;
}

interface ParsedFileMap {
    entries: Map<string, string>;      // Regular name=path entries (expanded from wildcards)
    builds: string[];                   // Directories to scan for builds
    sources: string[];                  // Directories to scan for sources
}

function parseFileMap(file: string): ParsedFileMap {
    const config = parseConfig(file);
    const result: ParsedFileMap = {
        entries: new Map<string, string>(),
        builds: [],
        sources: []
    };
    const dir = path.dirname(file);

    for (const [name, value] of Object.entries(config)) {
        if (!value) continue;

        // Handle special "builds" key
        if (name === "builds") {
            for (const b of value.split(",")) {
                const trimmed = b.trim();
                const expanded = expandPath(trimmed, dir);
                for (const p of expanded) {
                    if (verbose) display(` Build dir: ${p}\n`);
                    result.builds.push(p);
                }
            }
            continue;
        }

        // Handle special "sources" key
        if (name === "sources") {
            for (const s of value.split(",")) {
                const trimmed = s.trim();
                const expanded = expandPath(trimmed, dir);
                for (const p of expanded) {
                    if (verbose) display(` Source dir: ${p}\n`);
                    result.sources.push(p);
                }
            }
            continue;
        }

        // Check if value contains wildcards
        if (value.includes("*") || value.includes("?")) {
            const expanded = expandPath(value, dir);
            for (const p of expanded) {
                // Generate name from the expanded path
                const entryName = path.basename(p);
                if (verbose) display(` Mapped (glob): ${entryName} -> ${p}\n`);
                result.entries.set(entryName, p);
            }
        } else {
            const p = canonicalize(value, dir);
            if (verbose) display(` Mapped: ${name} -> ${p}\n`);
            result.entries.set(name, p);
        }
    }
    return result;
}

function parsePathConfig(configPath: string): PathConfig | null {
    const lsdevConfigFile = path.join(configPath, ".lsdev_config");
    if (cexists(lsdevConfigFile)) {
        return parseConfig(lsdevConfigFile);
    }
    return null;
}

function getPathConfig(configPath: string, key: string): string | undefined {
    if (!pathConfigs.has(configPath)) {
        pathConfigs.set(configPath, parsePathConfig(configPath));
    }
    const config = pathConfigs.get(configPath);
    const result = config?.[key];
    if (verbose) {
        display(` PathConfig: ${configPath}(${key}) -> '${result ?? "(undef)"}'\n`);
    }
    return result;
}

// ============================================================================
// Ancestor Finding
// ============================================================================

function findAncestor(file: string, startDir?: string): string | undefined {
    let dir = startDir ?? cwd;
    while (dir) {
        const r = path.join(dir, file).replace(/\/+/g, "/");
        if (cexists(r)) {
            return r;
        }
        if (dir.length <= 1) break;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return undefined;
}

// ============================================================================
// Source/Build Directory Detection
// ============================================================================

function processSourceDir(srcDir: string): boolean {
    if (
        cexists(path.join(srcDir, "configure")) ||
        cexists(path.join(srcDir, "Makefile")) ||
        cexists(path.join(srcDir, "CMakeLists.txt"))
    ) {
        return true;
    }
    if (cexists(path.join(srcDir, ".lsdev_shadows")) || cexists(path.join(srcDir, ".lsdev_config"))) {
        return true;
    }
    if (cisdir(path.join(srcDir, ".git"))) {
        return true;
    }
    return false;
}

function processBuildDir(buildDir: string): string | undefined {
    let srcDir: string | undefined;

    const cmakeCache = path.join(buildDir, "CMakeCache.txt");
    if (cexists(cmakeCache)) {
        if (verbose) display(` Found ${cmakeCache}!\n`);
        try {
            const content = fs.readFileSync(cmakeCache, "utf-8");
            for (const line of content.split("\n")) {
                const match = line.match(/CMAKE_HOME_DIRECTORY:INTERNAL=(.*)$/);
                if (match) {
                    srcDir = match[1];
                    break;
                }
            }
        } catch {
            // Ignore read errors
        }
    } else {
        const configStatus = path.join(buildDir, "config.status");
        if (cexists(configStatus)) {
            if (verbose) display(` Found ${configStatus}!\n`);
            try {
                const content = fs.readFileSync(configStatus, "utf-8");
                for (const line of content.split("\n")) {
                    const match = line.match(/([\w\-/.]+\/configure)/);
                    if (match) {
                        srcDir = path.dirname(match[1]);
                        break;
                    }
                }
            } catch {
                // Ignore read errors
            }
        } else if (cexists(path.join(buildDir, ".lsdev_config"))) {
            const source = getPathConfig(buildDir, "source");
            if (source) {
                const devRoot = devRoots.get(source);
                srcDir = devRoot ?? source;
            }
        }
    }

    if (srcDir) {
        srcDir = canonicalize(srcDir, buildDir);
    }
    return srcDir;
}

// ============================================================================
// Root Management
// ============================================================================

function isPathSame(path1: string, path2: string, resolve = true): boolean {
    if (path1 === path2) {
        return true;
    }
    if (resolve) {
        const resolved1 = resolveLinks(path1);
        const resolved2 = resolveLinks(path2);
        if (resolved1 && resolved2 && resolved1 === resolved2) {
            return true;
        }
    }
    if (verbose) display(`IsPathSame: '${path1}' vs '${path2}' :: false\n`);
    return false;
}

function isRootSource(root: Root): boolean {
    return !root.source || isPathSame(root.path, root.source);
}

function isRootBuild(root: Root): boolean {
    return root.source !== undefined;
}

function findRootInternal(targetPath: string, exact: boolean): Root | undefined {
    const resolvedTarget = resolveLinks(targetPath);
    let result: Root | undefined;

    for (const root of roots.values()) {
        const rootPath = resolveLinks(root.path);
        if (exact) {
            if (rootPath === resolvedTarget) {
                return root;
            }
        } else if (resolvedTarget && rootPath && resolvedTarget.startsWith(rootPath)) {
            if (!result || rootPath.length > (resolveLinks(result.path)?.length ?? 0)) {
                result = root;
            }
        }
    }
    return result;
}

function findRoot(targetPath: string, recurse = false): Root | undefined {
    if (verbose) display(`FindingRoot: ${targetPath}\n`);
    const normalized = canonicalize(targetPath);
    let result = findRootInternal(normalized, false);

    if (!result) {
        let current: string | undefined = normalized;
        let last: string | undefined;
        while (current && current !== last) {
            const p = resolveLinks(current);
            if (p) {
                const root = findRootInternal(p, true);
                if (root) {
                    result = root;
                    break;
                }
            }
            if (!recurse || current === "/") break;
            last = current;
            current = path.dirname(current);
        }
    }

    if (verbose) {
        display(`FindRoot: ${targetPath} -> ${result?.name ?? "(notfound)"}\n`);
    }
    return result;
}

function addRoot(name: string, rootPath: string, source?: string): Root {
    const normalizedPath = canonicalize(rootPath);
    const normalizedSource = source ? resolveLinks(canonicalize(source)) : undefined;

    const rootLocation = resolveLinks(normalizedPath);

    // If source same as path, update existing root
    if (normalizedSource && isPathSame(normalizedPath, normalizedSource)) {
        const existingRoot = findRoot(normalizedPath);
        if (existingRoot) {
            existingRoot.source = normalizedSource;
            if (verbose) {
                display(`AddedBuild(${existingRoot.key}) {${normalizedSource}} (${rootLocation})\n`);
            }
            return existingRoot;
        }
    }

    // Create new root
    let rootKey = rootLocation?.replace(/\//g, "_") ?? normalizedPath.replace(/\//g, "_");
    if (normalizedSource && !isPathSame(normalizedPath, normalizedSource)) {
        rootKey = `${buildPrefix}::${rootKey}`;
    } else {
        rootKey = `${srcPrefix}::${rootKey}`;
    }
    rootKey += `::${name}`;

    const existingConfig = pathConfigs.get(normalizedPath);
    const root: Root = {
        key: rootKey,
        name,
        path: normalizedPath,
        source: normalizedSource,
        ...(existingConfig ?? {})
    };

    roots.set(rootKey, root);

    if (verbose) {
        display(`Named Root: (${root.key}) [${root.name}] -> [${root.path}] {${root.source}} (${rootLocation})\n`);
    }
    return root;
}

function generateBuildName(root: Root): string {
    let name = root.name;
    if (isRootBuild(root) && root.source) {
        const srcRoot = findRoot(root.source);
        const srcName = srcRoot?.name ?? "";

        const builds = findRootBuilds(srcRoot);
        if (builds.length === 1) {
            const projectName = getProjectName(root.path);
            if (projectName) name = projectName;
        }
        if (!name.toLowerCase().includes(srcName.toLowerCase())) {
            name = name ? `${srcName}_${name}` : srcName;
        }
    }
    if (verbose) display(`Generated Name: ${name}\n`);
    return name;
}

function generateRootName(root: Root): string {
    let name = root.name;
    if (isRootBuild(root)) {
        name = generateBuildName(root);
    }
    if (name) {
        return (isRootSource(root) ? srcPrefix : buildPrefix) + name;
    }
    return "";
}

function getProjectName(projectPath: string): string | undefined {
    return getPathConfig(projectPath, "name");
}

function sortRootPredicate(root1: Root, root2: Root): number {
    if (isRootBuild(root1) && !isRootBuild(root2)) return 1;
    if (!isRootBuild(root1) && isRootBuild(root2)) return -1;

    const path1 = root1.path;
    const path2 = root2.path;
    const default1 = getPathConfig(path1, "default");
    const default2 = getPathConfig(path2, "default");

    if (default1 && !default2) return -1;
    if (default2 && !default1) return 1;

    return path2.localeCompare(path1);
}

function findRootBuilds(root: Root | undefined): Root[] {
    if (!root) return [];
    const srcRoot = isRootBuild(root) && root.source ? findRoot(root.source) : root;

    const result: Root[] = [];
    for (const buildRoot of roots.values()) {
        if (isRootBuild(buildRoot) && (!srcRoot || (buildRoot.source && findRoot(buildRoot.source) === srcRoot))) {
            result.push(buildRoot);
        }
    }
    return result.sort(sortRootPredicate);
}

function findDevRootName(targetPath: string, recurse = false): string | undefined {
    let result = getProjectName(targetPath);

    if (!result) {
        for (const [devRootName, devRootPath] of devRoots) {
            if (`${targetPath}/`.startsWith(`${devRootPath}/`)) {
                if (!result || devRootPath.length > (devRoots.get(result)?.length ?? 0)) {
                    result = devRootName;
                }
            }
        }
    }

    if (!result) {
        let current = canonicalize(targetPath);
        while (current) {
            for (const [devRootName, devRootPath] of devRoots) {
                if (isPathSame(devRootPath, current)) {
                    return devRootName;
                }
            }
            if (current.length <= 1 || !recurse) break;
            current = path.dirname(current);
        }
    }

    if (verbose) display(`FindDevRootName: ${targetPath} -> ${result}\n`);
    return result;
}

function findDevRoot(targetPath: string, recurse = false): string | undefined {
    const name = findDevRootName(targetPath, recurse);
    if (name) {
        const root = devRoots.get(name);
        if (verbose) display(`FindDevRoot: ${targetPath} -> '${root}' (${name})\n`);
        return root;
    }
    if (verbose) display(`FindDevRoot: ${targetPath} -> not found\n`);
    return undefined;
}

// ============================================================================
// Rest Directory Handling
// ============================================================================

function addRestDir(rootDirPath: string, restDir: string | undefined): string {
    let result = rootDirPath;
    if (restDir && cisdir(path.join(result, restDir))) {
        result = path.join(result, restDir);
        let current = canonicalize(result);
        while (current && current.length > rootDirPath.length) {
            if (cisdir(current)) {
                result = current;
                break;
            }
            current = path.dirname(current);
        }
    }
    return result;
}

function getRestDir(rootDirPath: string): string | undefined {
    let restDir: string | undefined;
    const regex1 = new RegExp(`^${rootDirPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(.*)`);
    const match1 = cwd.match(regex1);
    if (match1) {
        restDir = match1[1];
    }

    const resolvedRoot = resolveLinks(rootDirPath);
    const resolvedCwd = resolveLinks(cwd);
    if (resolvedRoot && resolvedCwd) {
        const regex2 = new RegExp(`^${resolvedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(.*)`);
        const match2 = resolvedCwd.match(regex2);
        if (match2) {
            restDir = match2[1];
        }
    }

    if (verbose) display(`GetRestDir(${cwd}): ${rootDirPath} -> ${restDir}\n`);
    return restDir;
}

// ============================================================================
// Root Relatedness
// ============================================================================

function isRootRelated(path1: string, path2: string): number {
    if (isPathSame(path1, path2)) {
        return 3;
    }

    const root1 = findRoot(path1);
    const root2 = findRoot(path2);

    if (root1 && root2) {
        if (root1.source) {
            if (isPathSame(root1.source, root2.path)) {
                return 1;
            }
            if (root2.source && isPathSame(root1.source, root2.source)) {
                return 2;
            }
        } else if (root2.source) {
            if (isPathSame(root1.path, root2.source)) {
                return 1;
            }
        }
    }

    if (verbose) display(`IsRootRelated: ${path1}::${path2} -> 0\n`);
    return 0;
}

// ============================================================================
// Filtering
// ============================================================================

type MatchComparator = (match: string, root: Root) => boolean;

function filterMatchesInternal(choices: string[], matchList: string[], comparator: MatchComparator): string[] {
    const result: string[] = [];

    for (const choice of choices) {
        let root = findRoot(choice);
        if (!root || root.ignore || !root.path) continue;

        if (matchList.length > 0) {
            for (const m of matchList) {
                let match = m;
                let inverse = false;
                if (match.startsWith("-")) {
                    match = match.slice(1);
                    inverse = true;
                }

                let isMatch = false;
                if (match === "src" || match === "source") {
                    isMatch = isRootSource(root);
                } else if (match === "build") {
                    isMatch = isRootBuild(root);
                } else if (match.startsWith("path:")) {
                    const pattern = match.slice(5);
                    isMatch = new RegExp(pattern, "i").test(root.path);
                } else {
                    isMatch = comparator(match, root);
                }

                if (inverse) isMatch = !isMatch;

                if (!isMatch) {
                    root = undefined;
                    break;
                }
            }
        } else if (readDevdirList !== 2 && readDevdirList !== -1 && rootDir && isPathSame(root.path, rootDir)) {
            continue;
        }

        if (root) {
            if (verbose) {
                display(`AddChoice: [${root.name}::${root.path}::${generateRootName(root)}]\n`);
            }
            result.push(root.path);
        }
    }

    return result;
}

function filterMatches(choices: string[], matchList: string[]): string[] {
    let result: string[] = [];

    if (matchOnly === "exact") {
        result = filterMatchesInternal(choices, matchList, (match, root) => {
            let prefix: string | undefined;
            let name = match;
            if (match.startsWith(srcPrefix)) {
                prefix = srcPrefix;
            } else if (match.startsWith(buildPrefix)) {
                prefix = buildPrefix;
            }
            if (prefix) {
                name = name.slice(prefix.length);
            }
            if ((!prefix || (prefix === buildPrefix && isRootBuild(root))) && name === generateBuildName(root)) {
                return true;
            }
            if ((!prefix || (prefix === srcPrefix && isRootSource(root))) && name === root.name) {
                return true;
            }
            return false;
        });
    } else {
        if ((!matchOnly || matchOnly === "word") && result.length === 0) {
            result = filterMatchesInternal(choices, matchList, (match, root) => {
                const name = generateRootName(root);
                const ws = "[_-]";
                return (
                    new RegExp(`^${match}${ws}`).test(name) ||
                    new RegExp(`${ws}${match}$`).test(name) ||
                    new RegExp(`${ws}${match}${ws}`).test(name)
                );
            });
        }
        if ((!matchOnly || matchOnly === "regexp") && result.length === 0) {
            result = filterMatchesInternal(choices, matchList, (match, root) => {
                return new RegExp(match, "i").test(generateRootName(root));
            });
        }
        if ((!matchOnly || matchOnly === "ido") && result.length === 0) {
            result = filterMatchesInternal(choices, matchList, (match, root) => {
                const pattern = match.split("").join(".*");
                return new RegExp(pattern, "i").test(generateRootName(root));
            });
        }
    }

    return result;
}

// ============================================================================
// Answer Generation
// ============================================================================

function answerRoot(root: Root, restDir?: string): void {
    let output: string | undefined;
    const fullPath = addRestDir(root.path, restDir);

    if (answer === "all") {
        output = `${generateRootName(root)} [${root.path}]`;
        if (root.source) {
            const srcRoot = findRoot(root.source);
            if (srcRoot) {
                output += ` [${generateRootName(srcRoot)}]`;
            }
        }
    } else if (answer === "simple_name") {
        output = getPathConfig(fullPath, "prompt") ?? generateRootName(root);
    } else if (answer === "source") {
        output = root.source ?? root.path;
    } else if (answer === "name") {
        output = generateRootName(root);
    } else if (answer === "rest") {
        output = getRestDir(fullPath);
    } else if (answer === "path") {
        output = fullPath;
    } else {
        let value = getPathConfig(fullPath, answer);
        if (!value && root.source) {
            value = getPathConfig(root.source, answer);
        }
        output = `${generateRootName(root)} ${value ?? ""}`;
    }

    if (output) {
        console.log(output);
        if (verbose) display(`Answering: ${output}\n`);
    }
}

// ============================================================================
// Main Logic
// ============================================================================

async function main(): Promise<void> {
    // Set display mode defaults
    if (!displayOnly && matches.length === 1 && matches[0] === "-") {
        displayOnly = "default";
    }

    if (displayOnly === "current") {
        readDevdirList = 3;
        if (answer === "path") answer = "name";
    } else if (displayOnly === "list") {
        if (answer === "path") answer = "all";
    }

    if (detectDefault === undefined) {
        detectDefault = readDevdirList === 1 || readDevdirList === 3;
    }

    // Load dev_directories config
    const devDirectoriesPath = expandHome("~/.dev_directories");
    if (cexists(devDirectoriesPath)) {
        if (verbose) display(`ProcessingDevDirectories: ${devDirectoriesPath}\n`);
        try {
            const content = fs.readFileSync(devDirectoriesPath, "utf-8");
            let currentPath: string | undefined;

            for (const line of content.split("\n")) {
                const trimmed = line.replace(/#.*$/, "").trim();
                const sectionMatch = trimmed.match(/^\[(.*)\]$/);
                if (sectionMatch) {
                    currentPath = sectionMatch[1];
                    continue;
                }

                const kvMatch = trimmed.match(/^(.+?)=(.*)$/);
                if (kvMatch) {
                    const key = kvMatch[1];
                    const value = kvMatch[2];

                    if (currentPath) {
                        if (!pathConfigs.has(currentPath)) {
                            const existingConfig = parsePathConfig(currentPath);
                            pathConfigs.set(currentPath, existingConfig ?? {});
                        }
                        const config = pathConfigs.get(currentPath);
                        if (!config) continue;
                        let finalValue = value;
                        if (key === "path" || key === "source") {
                            finalValue = canonicalize(value, path.dirname(devDirectoriesPath));
                        }
                        if (verbose) display(`Found PathConfig: {${currentPath}}{${key}} -> ${finalValue}\n`);
                        config[key] = finalValue;
                    } else {
                        if (key === "builds") {
                            // builds= supports comma-separated values and wildcards
                            for (const b of value.split(",")) {
                                const trimmed = b.trim();
                                const expanded = expandPath(trimmed, path.dirname(devDirectoriesPath));
                                for (const p of expanded) {
                                    if (verbose) display(`Found Build Root: ${p}\n`);
                                    buildRoots.push(p);
                                }
                            }
                        } else if (key === "sources") {
                            // sources= supports comma-separated values and wildcards
                            for (const s of value.split(",")) {
                                const trimmed = s.trim();
                                const expanded = expandPath(trimmed, path.dirname(devDirectoriesPath));
                                for (const p of expanded) {
                                    if (verbose) display(`Found Source Root: ${p}\n`);
                                    devRoots.set(`sources_${path.basename(p)}`, p);
                                }
                            }
                        } else if (value.includes("*") || value.includes("?")) {
                            // Entry with wildcards - expand and add each match
                            const expanded = expandPath(value, path.dirname(devDirectoriesPath));
                            for (const p of expanded) {
                                const entryName = path.basename(p);
                                if (verbose) display(`Found DevDirectory (glob): ${entryName} -> ${p}\n`);
                                devRoots.set(entryName, p);
                                addRoot(entryName, p);
                            }
                        } else {
                            const p = canonicalize(value, path.dirname(devDirectoriesPath));
                            if (verbose) display(`Found DevDirectory: ${key} -> ${p}\n`);
                            devRoots.set(key, p);
                            addRoot(key, p);
                        }
                    }
                }
            }
        } catch {
            // Ignore read errors
        }
    }

    // Figure out where we are in a shadow build and relevant source dir
    const buildMarker =
        findAncestor("CMakeCache.txt") ?? findAncestor("config.status") ?? findAncestor(".lsdev_config");

    if (buildMarker) {
        rootDir = path.dirname(buildMarker);
        if (readDevdirList === 1 && (matches.length === 0 || matches[0] === "-")) {
            readDevdirList = -2;
        }

        const srcDir = processBuildDir(rootDir);
        if (srcDir) {
            if (verbose) display(`SRCDIR: ${rootDir} -> ${srcDir}\n`);
            defaultDir = srcDir;
            let srcProjectName = findDevRootName(srcDir);
            if (!srcProjectName) srcProjectName = path.basename(srcDir);
            addRoot(srcProjectName || "src", srcDir);

            const bldProjectName = findDevRootName(rootDir);
            addRoot(bldProjectName || path.basename(rootDir), rootDir, srcDir);
        } else {
            let projectName = getProjectName(rootDir);
            if (!projectName) {
                projectName = findDevRootName(rootDir);
                if (!projectName) projectName = path.basename(rootDir);
            }
            if (verbose) display(`Source Detect: ${rootDir} [${projectName}]\n`);
            addRoot(projectName, rootDir);
        }
    }

    // Check if in a dev directory
    const devDirectory = findDevRoot(cwd, true);
    if (devDirectory) {
        if (readDevdirList === 1 && (matches.length === 0 || matches[0] === "-")) {
            readDevdirList = -2;
        }
        if (!rootDir) rootDir = devDirectory;
    } else {
        const shadowsFile = findAncestor(".lsdev_shadows");
        if (shadowsFile) {
            if (verbose) display(` Found ${shadowsFile}!\n`);
            const shadowsDir = path.dirname(shadowsFile);
            const projectName = findDevRootName(shadowsDir);

            const shadows = parseFileMap(shadowsFile);
            if (readDevdirList === 1 && (matches.length === 0 || matches[0] === "-")) {
                readDevdirList = -2;
            }
            if (!rootDir) rootDir = shadowsDir;

            const srcRoot = addRoot(projectName || "src", shadowsDir);

            // Add regular shadow entries
            for (const [shadowName, shadowPath] of shadows.entries) {
                addRoot(shadowName, shadowPath, srcRoot.path);
            }

            // Add builds from .lsdev_shadows to buildRoots for processing
            for (const buildPath of shadows.builds) {
                if (!buildRoots.includes(buildPath)) {
                    buildRoots.push(buildPath);
                }
            }

            // Process sources from .lsdev_shadows
            for (const sourcePath of shadows.sources) {
                if (detectDevdirs && cisdir(sourcePath)) {
                    try {
                        for (const subdir of fs.readdirSync(sourcePath)) {
                            if (subdir === "." || subdir === "..") continue;
                            const srcDir = path.join(sourcePath, subdir);
                            if (getPathConfig(srcDir, "ignore")) continue;
                            if (cisdir(srcDir) && processSourceDir(srcDir)) {
                                let srcProjectName = getProjectName(srcDir);
                                if (!srcProjectName) {
                                    srcProjectName = findDevRootName(srcDir);
                                    if (!srcProjectName) srcProjectName = path.basename(srcDir);
                                }
                                if (verbose) display(`Source Detect (from shadows): ${srcDir} [${srcProjectName}]\n`);
                                addRoot(srcProjectName, srcDir);
                            }
                        }
                    } catch {
                        // Ignore directory read errors
                    }
                }
            }
        } else {
            const srcMarker = findAncestor(".lsdev_config") ?? findAncestor("configure");
            if (srcMarker) {
                if (readDevdirList === 1 && (matches.length === 0 || matches[0] === "-")) {
                    readDevdirList = -2;
                }
                if (!rootDir) rootDir = path.dirname(srcMarker);
            }
        }
    }

    // Fall back to .git detection if no other root found
    if (!rootDir) {
        const gitDir = findAncestor(".git");
        if (gitDir) {
            const gitRoot = path.dirname(gitDir);
            if (verbose) display(`Git Root Detect: ${gitRoot}\n`);
            if (readDevdirList === 1 && (matches.length === 0 || matches[0] === "-")) {
                readDevdirList = -2;
            }
            rootDir = gitRoot;
            let projectName = getProjectName(gitRoot);
            if (!projectName) projectName = path.basename(gitRoot);
            addRoot(projectName, gitRoot);
        }
    }

    // Process sources directories
    const sourcesDir = devRoots.get("sources");
    if (sourcesDir) {
        devRoots.delete("sources");
        if (verbose) display(`Looking at source: ${sourcesDir}\n`);
        if (detectDevdirs && cisdir(sourcesDir)) {
            try {
                for (const subdir of fs.readdirSync(sourcesDir)) {
                    if (subdir === "." || subdir === "..") continue;
                    const srcDir = path.join(sourcesDir, subdir);
                    if (getPathConfig(srcDir, "ignore")) continue;
                    if (cisdir(srcDir) && processSourceDir(srcDir)) {
                        let projectName = getProjectName(srcDir);
                        if (!projectName) {
                            projectName = findDevRootName(srcDir);
                            if (!projectName) projectName = path.basename(srcDir);
                        }
                        if (verbose) display(`Source Detect: ${srcDir} [${projectName}]\n`);
                        addRoot(projectName, srcDir);
                    }
                }
            } catch {
                // Ignore directory read errors
            }
        }
    }

    // Process build roots
    for (const build of buildRoots) {
        if (verbose) display(`Looking at build: ${build}\n`);
        if (detectDevdirs && cisdir(build)) {
            try {
                for (const subdir of fs.readdirSync(build)) {
                    if (subdir === "." || subdir === "..") continue;
                    const buildDir = path.join(build, subdir);
                    if (getPathConfig(buildDir, "ignore")) continue;
                    if (!cisdir(buildDir)) continue;

                    const srcDir = processBuildDir(buildDir);
                    if (srcDir && (readDevdirList >= 1 || isPathSame(srcDir, rootDir ?? "") || isPathSame(srcDir, defaultDir ?? ""))) {
                        let projectName = getProjectName(srcDir);
                        if (!projectName) {
                            projectName = findDevRootName(srcDir);
                            if (!projectName) projectName = path.basename(srcDir);
                        }
                        if (projectName) {
                            if (verbose) display(`Build Detect: ${buildDir} (${srcDir}) [${projectName}]\n`);
                            const srcRoot = addRoot(projectName, srcDir);
                            let buildName = getProjectName(buildDir);
                            if (!buildName) buildName = subdir;
                            addRoot(buildName, buildDir, srcRoot.path);
                        }
                    }
                }
            } catch {
                // Ignore directory read errors
            }
        }
    }

    // Process all dev roots
    for (const [devRootName, devRoot] of devRoots) {
        if (readDevdirList >= 1) {
            const srcDir = processBuildDir(devRoot);
            if (srcDir) {
                if (verbose) display(`SRCDIR: ${rootDir} -> ${srcDir}\n`);
                const srcProjectName = findDevRootName(srcDir);
                addRoot(srcProjectName || "src", srcDir);
                const bldProjectName = findDevRootName(devRoot);
                addRoot(bldProjectName || path.basename(devRoot), devRoot, srcDir);
            } else {
                addRoot(devRootName, devRoot);
            }
        }

        const shadowsPath = path.join(devRoot, ".lsdev_shadows");
        if (cexists(shadowsPath)) {
            const shadows = parseFileMap(shadowsPath);

            // Add regular shadow entries
            for (const [shadowName, shadowPath] of shadows.entries) {
                addRoot(shadowName, shadowPath, devRoot);
            }

            // Add builds from .lsdev_shadows
            for (const buildPath of shadows.builds) {
                if (!buildRoots.includes(buildPath)) {
                    buildRoots.push(buildPath);
                }
            }

            // Process sources from .lsdev_shadows
            for (const sourcePath of shadows.sources) {
                if (detectDevdirs && cisdir(sourcePath)) {
                    try {
                        for (const subdir of fs.readdirSync(sourcePath)) {
                            if (subdir === "." || subdir === "..") continue;
                            const srcDir = path.join(sourcePath, subdir);
                            if (getPathConfig(srcDir, "ignore")) continue;
                            if (cisdir(srcDir) && processSourceDir(srcDir)) {
                                let srcProjectName = getProjectName(srcDir);
                                if (!srcProjectName) {
                                    srcProjectName = findDevRootName(srcDir);
                                    if (!srcProjectName) srcProjectName = path.basename(srcDir);
                                }
                                if (verbose) display(`Source Detect (from shadows): ${srcDir} [${srcProjectName}]\n`);
                                addRoot(srcProjectName, srcDir);
                            }
                        }
                    } catch {
                        // Ignore directory read errors
                    }
                }
            }
        }
    }

    // Figure out default
    if (!defaultDir) {
        let lsdevDefaultFile = rootDir ? findAncestor(".lsdev_default", rootDir) : undefined;
        if (!lsdevDefaultFile) lsdevDefaultFile = expandHome("~/.lsdev_default");

        if (lsdevDefaultFile && cexists(lsdevDefaultFile)) {
            const lsdevDefaultFileDir = path.dirname(lsdevDefaultFile);
            const resolvedDefaultDir = resolveLinks(lsdevDefaultFileDir);
            const resolvedRootDir = rootDir ? resolveLinks(rootDir) : undefined;

            if (!rootDir || (resolvedDefaultDir && resolvedRootDir && resolvedDefaultDir.length >= resolvedRootDir.length)) {
                if (verbose) display(` Found ${lsdevDefaultFile}!\n`);
                try {
                    defaultDir = fs.readFileSync(lsdevDefaultFile, "utf-8").trim();
                    if (verbose) display(`   Default ${defaultDir}\n`);
                    if (!findRoot(defaultDir)) {
                        addRoot("default", defaultDir);
                    }
                } catch {
                    // Ignore read errors
                }
            }
        }
    }

    if (verbose) display(`root=${rootDir} default=${defaultDir} cwd=${cwd}\n`);

    // Handle display modes
    if (displayOnly === "default") {
        if (defaultDir) {
            const root = findRoot(defaultDir, true);
            if (root) answerRoot(root);
        }
        return;
    }

    if (displayOnly === "current") {
        let current: string;
        if (matches.length === 0) {
            current = cwd;
        } else if (matches.length === 1 && matches[0] === "-") {
            current = defaultDir ?? cwd;
        } else {
            current = matches[0];
        }
        const root = findRoot(current, true);
        if (root) answerRoot(root);
        return;
    }

    // Main selection logic
    let restDir: string | undefined;
    const filteredMatches = matches.filter((match) => {
        if (match.includes("/")) {
            if (!restDir) {
                restDir = canonicalize(match);
                return false;
            } else {
                display(`Illegal match: ${match} (${restDir})\n`);
            }
        }
        return true;
    });

    let choices: string[] = [];

    if (filteredMatches.length === 1 && filteredMatches[0] === "-") {
        if (defaultDir) choices.push(defaultDir);
    } else if (filteredMatches.length === 0 && !detectRest && rootDir) {
        choices.push(rootDir);
    } else {
        for (const root of roots.values()) {
            choices.push(root.path);
        }
        choices = filterMatches(choices, filteredMatches);

        if (readDevdirList !== 2 && rootDir) {
            const currentRootDir = rootDir;
            const relatedChoices = choices.filter((choice) => {
                const related = isRootRelated(choice, currentRootDir);
                return related === 1 || related === 3;
            });
            if (relatedChoices.length > 0) {
                choices = relatedChoices;
            }
        }
    }

    if (!restDir && detectRest && rootDir) {
        restDir = getRestDir(rootDir);
    }

    // Deduplicate and apply defaults
    const seen = new Map<string, boolean>();
    const defaultInfo: { source?: string; path?: string } = {};
    const uniqChoices: string[] = [];

    for (const choice of choices) {
        const root = findRoot(choice);
        if (!root) continue;

        const rootName = generateRootName(root);
        if (defaultInfo.source === undefined) {
            defaultInfo.source = root.source;
        }

        if (detectDefault && isPathSame(defaultInfo.source ?? "", root.source ?? "")) {
            defaultInfo.source = root.source;
            if (getPathConfig(root.path, "default")) {
                if (defaultInfo.path) {
                    if (verbose) display("Default: too many!\n");
                    defaultInfo.source = "";
                    defaultInfo.path = undefined;
                } else {
                    defaultInfo.path = root.path;
                }
            }
        } else {
            if (verbose) display(`Default: incompatible: ${defaultInfo.source} vs ${root.source}\n`);
            defaultInfo.source = "";
            defaultInfo.path = undefined;
        }

        if (seen.has(rootName)) {
            if (verbose) display(`Filtered: ${rootName}\n`);
        } else {
            uniqChoices.push(root.path);
            seen.set(rootName, true);
        }
    }

    if (defaultInfo.path) {
        choices = [defaultInfo.path];
    } else {
        choices = uniqChoices;
    }

    choices.sort((a, b) => {
        const rootA = findRoot(a);
        const rootB = findRoot(b);
        if (!rootA || !rootB) return 0;
        return sortRootPredicate(rootA, rootB);
    });

    // Display or select
    if (displayOnly === "list") {
        for (const choice of choices) {
            const root = findRoot(choice);
            if (root) answerRoot(root, restDir);
        }
        return;
    }

    let index: number | undefined;

    if (choices.length <= 1) {
        index = choices.length === 1 ? 0 : undefined;
    } else {
        // Interactive selection
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stderr
        });

        const askQuestion = (prompt: string): Promise<string> => {
            return new Promise((resolve) => {
                rl.question(prompt, resolve);
            });
        };

        const currentMatches = [...filteredMatches];
        let currentChoices = [...choices];

        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (currentChoices.length <= 1) {
                index = currentChoices.length === 1 ? 0 : undefined;
                break;
            }

            for (let i = 0; i < currentChoices.length; i++) {
                const root = findRoot(currentChoices[i]);
                if (!root) continue;
                let line = `[${i + 1}] ${generateRootName(root)} [${root.path}]`;
                if (root.source) {
                    const srcRoot = findRoot(root.source);
                    if (srcRoot) {
                        line += ` [${generateRootName(srcRoot)}]`;
                    }
                }
                display(`${line}\n`);
            }

            let prompt = `[1..${currentChoices.length}]`;
            if (restDir) prompt += ` (${restDir})`;
            prompt += "> ";

            const choiceStr = await askQuestion(prompt);

            if (/^\d+$/.test(choiceStr)) {
                const choiceNum = parseInt(choiceStr, 10) - 1;
                if (choiceNum >= 0 && choiceNum < currentChoices.length) {
                    index = choiceNum;
                    choices = currentChoices;
                    break;
                }
            } else if (choiceStr) {
                currentMatches.push(choiceStr);
                currentChoices = filterMatches(currentChoices, currentMatches);
            }
        }

        rl.close();
    }

    if (index !== undefined && choices[index]) {
        const chosenPath = choices[index];
        if (verbose) {
            display(`Chose: ${rootDir}(${restDir}): ${index}: '${canonicalize(chosenPath)}'\n`);
        }

        const root = findRoot(chosenPath);
        if (root) {
            const finalRoot = { ...root };
            if (restDir) {
                finalRoot.path = addRestDir(finalRoot.path, restDir);
            }
            answerRoot(finalRoot);

            if (writeDefaultFile) {
                const lsdevDefaults: Map<string, string> = new Map();
                lsdevDefaults.set(expandHome("~/.lsdev_default"), finalRoot.path);

                if (rootDir && isRootRelated(rootDir, finalRoot.path) === 1) {
                    lsdevDefaults.set(path.join(finalRoot.path, ".lsdev_default"), rootDir);
                    lsdevDefaults.set(path.join(rootDir, ".lsdev_default"), finalRoot.path);
                }

                for (const [file, value] of lsdevDefaults) {
                    try {
                        if (verbose) display(`Writing ${file} -> ${value}\n`);
                        fs.writeFileSync(file, value + "\n");
                    } catch {
                        // Ignore write errors
                    }
                }
            }
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
