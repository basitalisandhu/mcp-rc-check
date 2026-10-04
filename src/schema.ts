import { join } from './pointer.js';
import { isObject, type JsonObject } from './util.js';

/** Keywords whose values are data, not subschemas, so they are not walked. */
const DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples']);

export interface SchemaNode {
  node: JsonObject;
  ptr: string;
  /**
   * The chain of `properties` keys from the schema root to this node, or null when the path passes
   * through anything else (items, composition, conditionals, $defs, $ref targets).
   */
  staticPath: string[] | null;
}

/** Visit every object subschema of a schema, depth first, with its pointer and static path. */
export function walkSchema(schema: unknown, ptr: string, visit: (n: SchemaNode) => void, limit = 10_000): void {
  let count = 0;
  const rec = (node: unknown, p: string, staticPath: string[] | null): void => {
    if (count++ > limit) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => rec(item, join(p, i), null));
      return;
    }
    if (!isObject(node)) return;
    visit({ node, ptr: p, staticPath });
    for (const [key, value] of Object.entries(node)) {
      if (DATA_KEYWORDS.has(key)) continue;
      if (key === 'properties' && isObject(value)) {
        for (const [prop, sub] of Object.entries(value)) {
          rec(sub, join(p, 'properties', prop), staticPath === null ? null : [...staticPath, prop]);
        }
        continue;
      }
      if (isObject(value) || Array.isArray(value)) rec(value, join(p, key), null);
    }
  };
  rec(schema, ptr, []);
}

/** RFC 9110 token characters (tchar). */
const TCHAR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export interface HeaderProblem {
  ptr: string;
  property: string;
  header: string;
  reason: string;
}

const PRIMITIVE = new Set(['integer', 'string', 'boolean']);

function typeProblem(node: JsonObject): string | undefined {
  const type = node.type;
  if (type === undefined) return undefined; // not determinable from the schema; not flagged (see docs/rules.md)
  const types = Array.isArray(type) ? type : [type];
  const bad = types.filter((t) => t !== 'null' && !(typeof t === 'string' && PRIMITIVE.has(t)));
  if (bad.length > 0) return `the property type ${JSON.stringify(type)} is not integer, string or boolean`;
  return undefined;
}

/** Check every x-mcp-header annotation in an inputSchema against the transport's constraints. */
export function checkHeaderAnnotations(schema: unknown, ptr: string): { problems: HeaderProblem[]; all: HeaderProblem[] } {
  const all: HeaderProblem[] = [];
  const problems: HeaderProblem[] = [];
  const seen = new Map<string, string>();
  walkSchema(schema, ptr, ({ node, ptr: p, staticPath }) => {
    if (!('x-mcp-header' in node)) return;
    const value = node['x-mcp-header'];
    const property = staticPath && staticPath.length > 0 ? staticPath.join('.') : `the subschema at ${p.slice(ptr.length) || '/'}`;
    const header = typeof value === 'string' ? value : JSON.stringify(value);
    const entry = { ptr: join(p, 'x-mcp-header'), property, header, reason: '' };
    all.push(entry);
    const reasons: string[] = [];
    if (typeof value !== 'string' || value === '') {
      reasons.push('the value must be a non-empty string');
    } else {
      if (/[\r\n\x00-\x1f\x7f]/.test(value)) reasons.push('the value contains control characters');
      else if (!TCHAR.test(value)) reasons.push('the value is not an HTTP field-name token (RFC 9110 tchar)');
      const lower = value.toLowerCase();
      const first = seen.get(lower);
      if (first !== undefined) reasons.push(`the name is not unique (case-insensitive): also used on ${first}`);
      else seen.set(lower, property);
    }
    if (staticPath === null || staticPath.length === 0) {
      reasons.push('the property is not statically reachable through a chain of `properties` keys from the root');
    }
    const tp = typeProblem(node);
    if (tp) reasons.push(tp);
    if (reasons.length > 0) problems.push({ ...entry, reason: reasons.join('; ') });
  });
  return { problems, all };
}

/** $ref values that do not point inside the same document ("#..."). */
export function externalRefs(schema: unknown, ptr: string): { ptr: string; ref: string }[] {
  const out: { ptr: string; ref: string }[] = [];
  walkSchema(schema, ptr, ({ node, ptr: p }) => {
    for (const key of ['$ref', '$dynamicRef']) {
      const ref = node[key];
      if (typeof ref === 'string' && !ref.startsWith('#')) out.push({ ptr: join(p, key), ref });
    }
  });
  return out;
}

export const DIALECT_2020_12 = new Set([
  'https://json-schema.org/draft/2020-12/schema',
  'https://json-schema.org/draft/2020-12/schema#',
]);
