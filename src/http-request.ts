/** Parsing and variable resolution for `http` code blocks (REST Client syntax). No UI, no I/O. */

export interface ParsedRequest {
  /** From `# @name login`: lets later requests use `{{login.response.body.$.token}}`. */
  name: string | null;
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
}

export interface StoredResponse {
  headers: [string, string][];
  body: string;
}

export interface ResolveContext {
  fileVars: Record<string, string>;
  envVars: Record<string, string>;
  responses: Map<string, StoredResponse>;
  processEnv: (name: string) => Promise<string>;
  dotenv: (name: string) => Promise<string>;
  /** Names of the variables that carry possible secrets (`.env`, process environment, environment file, earlier responses). */
  secrets?: Set<string>;
}

const METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "TRACE",
  "CONNECT",
]);
const SEPARATOR = /^#{3,}/;
const FILE_VARIABLE = /^@([\w.-]+)\s*=\s*(.*)$/;
const NAME_COMMENT = /^(?:#|\/\/)\s*@name\s+([\w.-]+)\s*$/;
const MAX_RESOLVE_PASSES = 5;

interface Chunk {
  lines: string[];
  /** Index of the first line in the block. */
  start: number;
}

/** Requests of a block are separated by lines starting with `###`. */
function splitChunks(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let current: Chunk = { lines: [], start: 0 };
  text.split(/\r?\n/).forEach((line, index) => {
    if (SEPARATOR.test(line)) {
      chunks.push(current);
      current = { lines: [], start: index + 1 };
    } else {
      current.lines.push(line);
    }
  });
  chunks.push(current);
  return chunks;
}

/** `@name = value` lines, anywhere in the text. */
export function fileVariables(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = FILE_VARIABLE.exec(line.trim());
    if (match) vars[match[1]] = match[2].trim();
  }
  return vars;
}

const isComment = (line: string) => /^\s*(#|\/\/)/.test(line);

/** Index of the request line in a chunk, or -1 when it holds only comments, variables or blank lines. */
function requestLineIndex(lines: string[]): number {
  const index = lines.findIndex((raw) => {
    const line = raw.trim();
    return line && !FILE_VARIABLE.test(line) && !isComment(line);
  });
  return index;
}

/** Per request, 0-based lines of the block: where its section starts (just under the `###`) and the request line itself. */
export function requestSections(text: string): { start: number; request: number }[] {
  return splitChunks(text).flatMap((chunk) => {
    const index = requestLineIndex(chunk.lines);
    return index < 0 ? [] : [{ start: chunk.start, request: chunk.start + index }];
  });
}

/** Returns null when the chunk holds no request line (only comments, variables or blank lines). */
function parseChunk(lines: string[]): ParsedRequest | null {
  let index = requestLineIndex(lines);
  if (index < 0) return null;
  let name: string | null = null;
  for (const raw of lines.slice(0, index))
    name = NAME_COMMENT.exec(raw.trim())?.[1] ?? name;

  let requestLine = lines[index++].trim();
  while (index < lines.length && /^\s+[?&]/.test(lines[index]))
    requestLine += lines[index++].trim();
  requestLine = requestLine.replace(/\s+HTTP\/[\d.]+$/i, "");
  const space = requestLine.search(/\s/);
  const first = space < 0 ? requestLine : requestLine.slice(0, space);
  const hasMethod = METHODS.has(first.toUpperCase());
  const method = hasMethod ? first.toUpperCase() : "GET";
  const url = (hasMethod ? requestLine.slice(first.length) : requestLine).trim();

  const headers: [string, string][] = [];
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      break;
    }
    if (isComment(line)) continue;
    const colon = line.indexOf(":");
    if (colon > 0)
      headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  const body = lines.slice(index).join("\n").replace(/\s+$/, "");
  return { name, method, url, headers, body };
}

/** The request that contains the given line (0-based) of a block. */
export function requestAt(text: string, line: number): ParsedRequest | null {
  const chunk = splitChunks(text).find(
    (candidate) =>
      line >= candidate.start && line <= candidate.start + candidate.lines.length,
  );
  return chunk ? parseChunk(chunk.lines) : null;
}

/** Minimal JSONPath: `$`, `$.a.b[0].c`, or the same without `$`. */
export function jsonPath(value: unknown, path: string): string {
  let current: unknown = value;
  const steps = path.replace(/^\$\.?/, "");
  for (const match of steps.matchAll(/\[(\d+)\]|([^.[\]]+)/g)) {
    if (current === null || typeof current !== "object")
      throw new Error(`path ${path} not found`);
    const key = match[1] ?? match[2];
    current = (current as Record<string, unknown>)[key];
  }
  if (current === undefined) throw new Error(`path ${path} not found`);
  return typeof current === "string" ? current : JSON.stringify(current);
}

function fromResponse(
  reference: string,
  responses: Map<string, StoredResponse>,
): string | null {
  const match = /^([\w.-]+?)\.response\.(body|headers)(?:\.(.+))?$/.exec(reference);
  if (!match) return null;
  const [, requestName, part, path = "*"] = match;
  const stored = responses.get(requestName);
  if (!stored) throw new Error(`no response yet for request ${requestName}: send it first`);
  if (part === "headers") {
    const header = stored.headers.find(
      ([key]) => key.toLowerCase() === path.toLowerCase(),
    );
    if (!header) throw new Error(`header ${path} not found in ${requestName}`);
    return header[1];
  }
  if (path === "*") return stored.body;
  try {
    return jsonPath(JSON.parse(stored.body), path);
  } catch (error) {
    throw new Error(
      `${requestName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Moves a date by `amount` units: y, Q, M, w, d, h, m, s, ms (as in REST Client, `m` is minutes and `M` months). */
function shifted(amount: string | undefined, unit: string | undefined): Date {
  const date = new Date();
  if (!amount) return date;
  const count = Number(amount);
  switch (unit ?? "s") {
    case "y":
      date.setFullYear(date.getFullYear() + count);
      break;
    case "Q":
      date.setMonth(date.getMonth() + count * 3);
      break;
    case "M":
      date.setMonth(date.getMonth() + count);
      break;
    case "w":
      date.setDate(date.getDate() + count * 7);
      break;
    case "d":
      date.setDate(date.getDate() + count);
      break;
    case "h":
      date.setHours(date.getHours() + count);
      break;
    case "m":
      date.setMinutes(date.getMinutes() + count);
      break;
    case "ms":
      date.setMilliseconds(date.getMilliseconds() + count);
      break;
    default:
      date.setSeconds(date.getSeconds() + count);
  }
  return date;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** ISO 8601 in local time with the UTC offset, for example 2026-10-21T09:20:27.123+02:00. */
function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
  );
}

async function systemVariable(
  expression: string,
  context: ResolveContext,
): Promise<string> {
  const [name, ...args] = expression.split(/\s+/);
  switch (name) {
    case "$guid":
      return crypto.randomUUID();
    case "$timestamp":
      return String(Math.floor(shifted(args[0], args[1]).getTime() / 1000));
    case "$randomInt": {
      const min = Number(args[0] ?? 0);
      const max = Number(args[1] ?? 1000);
      return String(min + Math.floor(Math.random() * (max - min)));
    }
    case "$datetime": {
      const date = shifted(args[1], args[2]);
      return args[0] === "rfc1123" ? date.toUTCString() : date.toISOString();
    }
    case "$localDatetime": {
      const date = shifted(args[1], args[2]);
      return args[0] === "rfc1123" ? date.toUTCString() : localIso(date);
    }
    case "$processEnv":
      if (!args[0]) throw new Error("$processEnv needs a variable name");
      return context.processEnv(args[0]);
    case "$dotenv":
      if (!args[0]) throw new Error("$dotenv needs a variable name");
      return context.dotenv(args[0]);
    default:
      throw new Error(`unknown system variable ${name}`);
  }
}

interface Lookup {
  value: string;
  /** Only text the user wrote may contain more variables: a value from a response or the environment is data. */
  nested: boolean;
}

async function lookup(name: string, context: ResolveContext): Promise<Lookup> {
  if (name.startsWith("$")) {
    if (/^\$(dotenv|processEnv)\b/.test(name)) context.secrets?.add(name);
    return { value: await systemVariable(name, context), nested: false };
  }
  if (name in context.fileVars) return { value: context.fileVars[name], nested: true };
  if (name in context.envVars) {
    context.secrets?.add(name);
    return { value: context.envVars[name], nested: true };
  }
  const reference = fromResponse(name, context.responses);
  if (reference !== null) {
    context.secrets?.add(name);
    return { value: reference, nested: false };
  }
  throw new Error(`unresolved variable {{${name}}}`);
}

const VARIABLE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** Replaces every `{{name}}`. Values of `@var` and environment variables may use more variables (a few levels deep); response and system values are inserted as they are and never expanded again. */
export async function resolveText(
  text: string,
  context: ResolveContext,
  depth = 0,
): Promise<string> {
  if (depth > MAX_RESOLVE_PASSES) throw new Error("variables nested too deeply");
  const values = new Map<string, string>();
  for (const [, name] of text.matchAll(VARIABLE)) {
    if (values.has(name)) continue;
    const found = await lookup(name, context);
    values.set(
      name,
      found.nested ? await resolveText(found.value, context, depth + 1) : found.value,
    );
  }
  return text.replace(VARIABLE, (_all, name: string) => values.get(name) ?? "");
}

/** `Authorization: Basic user:pass` or `Basic user pass` becomes the encoded form. */
export function encodeBasicAuth(value: string): string {
  const match = /^Basic\s+(.+)$/i.exec(value);
  if (!match || !/[:\s]/.test(match[1])) return value;
  const credentials = match[1].replace(/\s+/, ":");
  const bytes = new TextEncoder().encode(credentials);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

/** The request with every variable replaced, ready for the backend. */
export async function resolveRequest(
  request: ParsedRequest,
  context: ResolveContext,
): Promise<ParsedRequest> {
  const headers: [string, string][] = [];
  for (const [key, value] of request.headers) {
    const resolved = await resolveText(value, context);
    headers.push([
      await resolveText(key, context),
      key.toLowerCase() === "authorization" ? encodeBasicAuth(resolved) : resolved,
    ]);
  }
  return {
    ...request,
    url: await resolveText(request.url, context),
    headers,
    body: await resolveText(request.body, context),
  };
}
