import type { ODataMetadata } from './types.js';
import {
  findEntityByName,
  findEntitySet,
  getEffectiveNavigationProperties,
  getEffectiveProperties,
} from './resolve.js';

/** A single comparison in a $filter expression. */
export interface FilterClause {
  property: string;
  /** eq, ne, gt, ge, lt, le, contains, startswith, endswith, in */
  operator: string;
  /** Raw input value; formatted per the property's EDM type when known. */
  value: string;
}

/** Nested $expand segment. */
export interface ExpandNode {
  navProperty: string;
  select?: string[];
  filters?: FilterClause[];
  filterLogic?: 'and' | 'or';
  /** e.g. "Name asc" or just "Name" (defaults to asc) */
  orderBy?: string;
  top?: number;
  skip?: number;
  expand?: ExpandNode[];
}

/** A grouping property in a $apply/groupby transformation. */
export interface GroupByNode {
  property: string;
  alias?: string;
}

/** An aggregate in a $apply/groupby transformation. */
export interface AggregateNode {
  method: 'count' | 'sum' | 'avg' | 'min' | 'max';
  /** Omitted for count, which aggregates rows. */
  property?: string;
  alias?: string;
}

/** Options for building an OData V4 query URL. */
export interface QueryOptions {
  entitySet: string;
  /**
   * Entity type the query is *about*, used to resolve property types and
   * `$expand` targets. Needed when `entitySet` is a derived-type cast
   * (`Products/Model.FeaturedProduct`), where the path segment is the set but
   * literals must still be typed from the derived type. Defaults to the type
   * declared by `entitySet`.
   */
  rootEntityName?: string;
  filters?: FilterClause[];
  filterLogic?: 'and' | 'or';
  select?: string[];
  expand?: ExpandNode[];
  groupBy?: GroupByNode[];
  aggregates?: AggregateNode[];
  orderBy?: string;
  top?: number;
  skip?: number;
  count?: boolean;
  search?: string;
  /** Optional base URL; when set an absolute URL is returned. */
  baseUrl?: string;
  /** When provided, filter literals are typed from the model. */
  metadata?: ODataMetadata;
  /** Receives non-fatal problems, e.g. properties that are not in the model. */
  onWarning?: (message: string) => void;
}

const COMPARISON_OPERATORS = new Set(['eq', 'ne', 'gt', 'ge', 'lt', 'le']);
const STRING_FUNCTION_OPERATORS = new Set(['contains', 'startswith', 'endswith']);
const ALLOWED_OPERATORS = new Set([...COMPARISON_OPERATORS, ...STRING_FUNCTION_OPERATORS, 'in']);

const NUMERIC_TYPES = new Set([
  'Edm.Int16',
  'Edm.Int32',
  'Edm.Int64',
  'Edm.Byte',
  'Edm.SByte',
  'Edm.Decimal',
  'Edm.Double',
  'Edm.Single',
]);

/**
 * Integral EDM types take an optional sign and digits only — no fraction, no
 * exponent. Exported so consumers that re-encode a literal (the MCP action
 * body) apply exactly the same rule the formatter validated.
 */
export const INTEGER_TYPES = new Set([
  'Edm.Byte',
  'Edm.SByte',
  'Edm.Int16',
  'Edm.Int32',
  'Edm.Int64',
]);

/** Inclusive bounds, as BigInt so `Edm.Int64` survives 64-bit values. */
const INTEGER_RANGES: Record<string, { min: bigint; max: bigint }> = {
  'Edm.Byte': { min: 0n, max: 255n },
  'Edm.SByte': { min: -128n, max: 127n },
  'Edm.Int16': { min: -32768n, max: 32767n },
  'Edm.Int32': { min: -2147483648n, max: 2147483647n },
  'Edm.Int64': { min: -9223372036854775808n, max: 9223372036854775807n },
};

/**
 * Per-type magnitude caps for the non-integer types, checked explicitly
 * because `Number.isFinite` only knows binary64:
 *
 * - `Edm.Single` is IEEE-754 binary32, whose maximum finite value is
 *   2^128 - 2^104 = 3.4028234663852886e38. `Math.fround` is the right oracle:
 *   it accepts exactly the literals that binary32 can hold, including
 *   `3.4028235e38` (how .NET prints float.MaxValue, which rounds to the
 *   finite maximum) while `1e39` and `3.4028236e38` round to Infinity. The
 *   previous comparison against binary64 magnitude accepted the first as
 *   finite and rejected the last two — but also rejected the round-trippable
 *   float.MaxValue spelling, so a value a service returns could not be sent
 *   back. `1e39` parses to a perfectly finite double, which is why the old
 *   check needed replacing in both directions.
 * - `Edm.Decimal` has no digit cap in the ABNF (decimalLiteral), and CSDL
 *   imposes no general digit limit: `Precision` is optional and its default
 *   is service-defined, and `Precision="floating"` explicitly permits values
 *   like `9.999999e96`. The 38-digit bound below is therefore a *deliberate
 *   product cap*, not a necessary condition derived from the spec: it matches
 *   what mainstream fixed-precision stores can hold (SQL Server decimal(38,x);
 *   .NET's SqlDecimal carries 28 digits of *scale*, not 38 digits of
 *   precision) and keeps the builder from emitting queries most services will
 *   reject. It is applied without consulting the property's `Precision`/`Scale`
 *   facets, which this module does not carry, so a value beyond it may still
 *   be legal for a service that declares floating precision. Before the cap
 *   the limit was an accident of binary64: values up to ~1.797e308 slipped
 *   through while a 400-digit integer overflowed to Infinity and was rejected
 *   as "not a finite number". The check runs on the decimal digits rather
 *   than on `Number(...)`: `Number('999…9')` (38 nines) rounds to the same
 *   double as `1e38`, so a float comparison would reject the largest
 *   in-cap 38-digit integer.
 * - `Edm.Double` keeps the binary64 finiteness check below: its range *is*
 *   binary64, so that check is the right oracle for it.
 *
 * INF/-INF/NaN are not part of these bounds: they are spelled nanInfinity in
 * the ABNF and handled before the numeric parse.
 */
const DECIMAL_MAX_DIGITS = 38;

/**
 * Is the decimal within the deliberate 38-digit product cap, decided exactly
 * on the decimal digits?
 *
 * A decimal literal is `m_int * 10^(exp - fracLen)` where m_int is the digit
 * string without leading zeros, which is below 1e38 precisely when
 * `digits(m_int) + exp - fracLen <= 38`. Pure integer arithmetic, so the
 * boundary is not blurred by binary64 rounding. A zero mantissa is zero
 * whatever the exponent says: `0e1000` is accepted.
 */
function decimalIsWithinBound(numeric: string): boolean {
  const unsigned = numeric.replace(/^[+-]/, '');
  let mantissa = unsigned;
  let exp = 0;
  const eIndex = unsigned.search(/[eE]/);
  if (eIndex !== -1) {
    mantissa = unsigned.slice(0, eIndex);
    exp = Number(unsigned.slice(eIndex + 1));
  }
  const dotIndex = mantissa.indexOf('.');
  const fracLen = dotIndex === -1 ? 0 : mantissa.length - dotIndex - 1;
  const digits = mantissa.replace(/\./g, '').replace(/^0+/, '');
  if (digits.length === 0) return true; // zero mantissa: 0 * 10^k = 0
  return digits.length + exp - fracLen <= DECIMAL_MAX_DIGITS;
}
const DATE_TYPES = new Set(['Edm.Date', 'Edm.DateTimeOffset', 'Edm.DateTime']);

/** Shape checks for the ISO 8601 forms OData V4 uses. */
const DATE_PATTERNS: Record<string, RegExp> = {
  'Edm.Date': /^\d{4}-\d{2}-\d{2}$/,
  'Edm.DateTimeOffset': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  'Edm.DateTime': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/,
  'Edm.TimeOfDay': /^\d{2}:\d{2}:\d{2}(\.\d+)?$/,
  'Edm.Duration': /^-?P(?!$)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/,
};

/**
 * Does the calendar actually have this date? `Date` rolls 2024-02-31 over to
 * 2024-03-02, so comparing the fields after the round-trip catches 31-day
 * months, non-leap February 29ths and month 13 alike. `setUTCFullYear` is used
 * rather than `Date.UTC(year, ...)`, which maps years 0-99 into the 1900s.
 */
function isRealCalendarDate(year: string, month: string, day: string): boolean {
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
  );
}

/** Reject values like 2024-13-45, 2024-02-31 or "yesterday" that a service would refuse. */
function isPlausibleDateTime(type: string, raw: string): boolean {
  const pattern = DATE_PATTERNS[type];
  if (!pattern) return true;
  if (!pattern.test(raw.trim())) return false;

  if (type === 'Edm.Duration') return true;

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (match && !isRealCalendarDate(match[1], match[2], match[3])) {
    return false;
  }

  const time = /T(\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (time) {
    const [, hours, minutes, seconds] = time;
    if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 60) return false;
  }
  return true;
}

/**
 * Format a raw input value as an OData V4 literal for the given EDM type.
 * V4 removed V2/V3 prefixes (guid'…', datetime'…'); dates and guids are
 * bare, strings are single-quoted with '' escaping.
 */
export function formatV4Literal(value: string, edmType?: string): string {
  if (value === undefined || value === null) return 'null';
  const raw = String(value);
  const type = edmType ?? inferTypeFromValue(raw);

  if (raw === '') {
    if (type === 'Edm.String') return "''";
    throw new Error(`Empty value is not valid for type ${type}`);
  }

  if (raw.toLowerCase() === 'null' && type !== 'Edm.String') {
    return 'null';
  }

  if (type === 'Edm.Boolean') {
    const lowered = raw.toLowerCase();
    if (lowered !== 'true' && lowered !== 'false') {
      throw new Error(`Invalid boolean value: ${raw}`);
    }
    return lowered;
  }

  if (NUMERIC_TYPES.has(type)) {
    const numeric = raw.trim();

    // Integral types take `[sign] 1*10DIGIT` (OData ABNF). The floating-point
    // pattern used here previously accepted `1.5` and `1e5` for `Edm.Int32` and
    // emitted them verbatim, so the service rejected a query the builder had
    // presented as valid.
    if (INTEGER_TYPES.has(type)) {
      if (!/^[+-]?\d+$/.test(numeric)) {
        throw new Error(`Invalid ${type} value: ${raw} (expected an integer)`);
      }
      const range = INTEGER_RANGES[type];
      const asBigInt = BigInt(numeric);
      if (asBigInt < range.min || asBigInt > range.max) {
        throw new Error(`Invalid ${type} value: ${raw} (out of range ${range.min}..${range.max})`);
      }
      return numeric;
    }

    // nanInfinity = "NaN" / "-INF" / "INF" is an alternative of
    // decimalLiteral, which the ABNF shares between doubleLiteral and
    // singleLiteral: these are legal literals for the binary floating types
    // and refusing them was the same defect as accepting too much elsewhere.
    // Edm.Decimal cannot represent them (no decimal implementation has a NaN
    // or an infinity) and the integer rules do not admit them, so they are
    // rejected there with a message that says why.
    if (numeric === 'NaN' || numeric === 'INF' || numeric === '-INF') {
      if (type === 'Edm.Double' || type === 'Edm.Single') return numeric;
      throw new Error(
        `Invalid ${type} value: ${raw} (${numeric} is only valid for Edm.Double or Edm.Single)`,
      );
    }

    if (!isNumericLiteral(numeric)) {
      throw new Error(`Invalid ${type} value: ${raw}`);
    }
    if (type === 'Edm.Single') {
      // The oracle is binary32, not binary64: `3.4028235e38` is .NET's
      // float.MaxValue spelling and rounds back to the finite maximum, while
      // `3.4028236e38` and `1e39` round to Infinity.
      if (!Number.isFinite(Math.fround(Number(numeric)))) {
        throw new Error(`Invalid Edm.Single value: ${raw} (not a finite binary32 value)`);
      }
    } else if (type === 'Edm.Decimal') {
      if (!decimalIsWithinBound(numeric)) {
        throw new Error(`Invalid Edm.Decimal value: ${raw} (out of range, magnitude < 1e38)`);
      }
    } else if (!Number.isFinite(Number(numeric))) {
      // Edm.Double: `1e999` parses to Infinity — a number syntactically, not
      // a usable literal.
      throw new Error(`Invalid ${type} value: ${raw} (not a finite number)`);
    }
    return numeric;
  }

  if (DATE_TYPES.has(type) || type in DATE_PATTERNS) {
    const value = raw.trim();
    if (!value) throw new Error(`Empty ${type} value`);
    if (!isPlausibleDateTime(type, value)) {
      throw new Error(`Invalid ${type} value: ${raw} (expected an ISO 8601 ${type} literal)`);
    }
    return value;
  }

  if (type === 'Edm.Guid') {
    if (
      !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(raw)
    ) {
      throw new Error(`Invalid Edm.Guid value: ${raw}`);
    }
    return raw;
  }

  if (type === 'Edm.Binary') {
    if (/^X'.*'$/.test(raw)) return raw;
    return `X'${raw.replace(/^0x/i, '')}'`;
  }

  if (!type.startsWith('Edm.')) {
    // Enum member or other named type: NS.EnumType'VALUE'
    return `${type}'${raw.replace(/'/g, "''")}'`;
  }

  return `'${raw.replace(/'/g, "''")}'`;
}

/**
 * Percent-encode only the characters that would corrupt a query string:
 * `%` (existing escape), `&` (new parameter), `#` (fragment), and `+`
 * (decoded as a space by many servers). Spaces, quotes, and `=` are legal in
 * an OData system query option and are left readable.
 */
function encodeQueryValue(value: string): string {
  return value.replace(/[%&#+]/g, (char) => {
    switch (char) {
      case '%':
        return '%25';
      case '&':
        return '%26';
      case '#':
        return '%23';
      default:
        return '%2B';
    }
  });
}

/** An OData simple identifier, e.g. `Name` or `_internal`. */
const SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A property path, e.g. `Name` or `Address/City`. */
const PROPERTY_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * One `/`-separated resource path segment. Dots are allowed because a derived
 * type is addressed with a qualified cast (`Products/Model.FeaturedProduct`),
 * which is not a property path.
 */
const RESOURCE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * A `$select` item (OData V4 ABNF `selectItem`): a star, an all-operations star
 * for a schema, or a property path optionally prefixed with the type it is
 * selected from.
 *
 *   `*`                  `NS.*`                 `Name`
 *   `Address/City`       `NS.Part/Name`         `A/B/C`
 *
 * This previously used the plain-identifier matcher, which rejected `*` and
 * every structural path — the two most common shapes in practice.
 */
const SELECT_ITEM =
  /^(?:\*|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\.\*|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\/[A-Za-z_][A-Za-z0-9_]*)*)$/;

/**
 * A key predicate appended to a resource segment: `('P1')`, `(1)`,
 * `(A=1,B='x')`, `(ID='a%20b')`.
 *
 * Values must survive being concatenated into a URL rather than encoded, so a
 * quoted value allows only characters that are legal raw *or* a well-formed
 * percent escape. `/` and `\` are excluded even though both are legal inside an
 * OData string: they are the path separator, and WHATWG URL normalizes `\` to
 * `/`, so `Parts('a/b')` would address a different resource. `%20`-`%26` and
 * `%28`-`%2F` are allowed so a value that genuinely needs a space or a slash
 * can be spelled legibly — which is also what the MCP key builder emits — but
 * `%27` is not content: `SQUOTE = "'" / "%27"` makes it a quote, so the
 * predicate is normalised before parsing and the quoted-value matcher accepts
 * only `pct-encoded-no-SQUOTE` (which also excludes `%70`-`%7F`).
 *
 * The predicate is validated by a small parser instead of one regex, because
 * the ABNF rules (oasis-tcs/odata-abnf: `compoundKey = OPEN keyValuePair *(
 * COMMA keyValuePair )`) are structural: once a comma appears, *every*
 * element must be `name=value`, and `keyPropertyValue` is a choice of
 * literal shapes — no `null` alternative. Each value is checked against those
 * shapes rather than against a permissive character class; numeric tokens may
 * be `int64Literal = [ SIGN ] 1*19DIGIT` (range-restricted) or the uncapped
 * `decimalLiteral`.
 */

/** An OData key property name: `odataIdentifier` in the ABNF. */
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// prettier-ignore
const KEY_QUOTED_INNER = /^(?:[^'%/\\?#&\s\p{Cc}]|%(?:[01345689A-Fa-f][0-9A-Fa-f]|2[01345689A-Fa-f])|'')*$/u;

const KEY_GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** `[ SIGN ] 1*DIGIT`: a bare integer token, i.e. int64Literal in a URL. */
const KEY_BARE_INTEGER = /^[+-]?\d+$/;

/**
 * decimalLiteral = [ SIGN ] 1*DIGIT [ "." 1*DIGIT ] [ "e" [ SIGN ] 1*DIGIT ],
 * shared with doubleLiteral/singleLiteral. `E` is accepted next to the ABNF's
 * lowercase `e`, matching `isNumericLiteral` elsewhere in this module.
 */
const KEY_DECIMAL = /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** date = year "-" month "-" day, with ABNF month/day ranges. */
const KEY_DATE = /^(-?)(\d{4})-(\d{2})-(\d{2})$/;

/** dateTimeOffsetLiteral = date "T" timeOfDayLiteral ( "Z" / SIGN hour COLON minute ). */
// prettier-ignore
const KEY_DATE_TIME = /^(-?)(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** timeOfDayLiteral = hour COLON minute [ COLON second [ "." 1*DIGIT ] ]. */
const KEY_TIME = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

function inRange(digitPair: string, min: number, max: number): boolean {
  const n = Number(digitPair);
  return n >= min && n <= max;
}

function validDateFields(year: string, month: string, day: string): boolean {
  return isRealCalendarDate(year, month, day);
}

function validTimeFields(hour: string, minute: string, second?: string): boolean {
  if (!inRange(hour, 0, 23) || !inRange(minute, 0, 59)) return false;
  // The ABNF allows second = 60 for leap seconds.
  if (second !== undefined && !inRange(second, 0, 60)) return false;
  return true;
}

/** Shape plus field ranges for bare date, date-time and time-of-day tokens. */
function isValidKeyTemporal(value: string): boolean {
  // Groups: [1] sign, [2] year, [3] month, [4] day, [5] hour, [6] minute,
  // [7] second, [8] zone.
  const date = KEY_DATE.exec(value);
  if (date) return validDateFields(date[2], date[3], date[4]);

  const dateTime = KEY_DATE_TIME.exec(value);
  if (dateTime) {
    if (!validDateFields(dateTime[2], dateTime[3], dateTime[4])) return false;
    if (!validTimeFields(dateTime[5], dateTime[6], dateTime[7])) return false;
    const offset = dateTime[8];
    if (offset === 'Z') return true;
    return inRange(offset.slice(1, 3), 0, 23) && inRange(offset.slice(4, 6), 0, 59);
  }

  const time = KEY_TIME.exec(value);
  if (time) return validTimeFields(time[1], time[2], time[3]);

  return false;
}

/** An unquoted value must be one of the keyPropertyValue alternatives. */
function isValidKeyUnquotedValue(value: string): boolean {
  if (value === 'true' || value === 'false') return true;
  // nanInfinity, exactly these three spellings (the ABNF has no `+INF`).
  if (value === 'NaN' || value === 'INF' || value === '-INF') return true;
  if (KEY_GUID.test(value)) return true;

  if (KEY_BARE_INTEGER.test(value) && value.replace(/^[+-]/, '').length <= 19) {
    // A token of at most 19 digits has the int64Literal shape, so it is held
    // to the ABNF rule's semantic restriction, the int64 range. A longer
    // token is not an int64Literal at all and falls through instead.
    const range = INTEGER_RANGES['Edm.Int64'];
    const parsed = BigInt(value);
    if (parsed < range.min || parsed > range.max) return false;
  }

  // decimalLiteral = [ SIGN ] 1*DIGIT has no digit cap and no range, so every
  // bare integer that is not rejected as an out-of-range int64Literal — and
  // that includes 27-digit spellings of small values like
  // `000000000000000000000000001` — is accepted here.
  if (KEY_DECIMAL.test(value)) return true;

  return isValidKeyTemporal(value);
}

function isValidKeyValue(value: string): boolean {
  if (value.startsWith("'")) {
    return value.length >= 2 && value.endsWith("'") && KEY_QUOTED_INNER.test(value.slice(1, -1));
  }
  return isValidKeyUnquotedValue(value);
}

/**
 * Split predicate content on top-level commas. Quotes are tracked (with `''`
 * as an escaped quote); a structural paren outside quotes or an unbalanced
 * quote makes the predicate invalid, signalled by null.
 */
function splitKeyElements(content: string): string[] | null {
  const elements: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (inQuote) {
      if (char === "'") {
        if (content[i + 1] === "'") {
          current += "''";
          i += 1;
          continue;
        }
        inQuote = false;
      }
      current += char;
      continue;
    }
    if (char === "'") {
      inQuote = true;
      current += char;
      continue;
    }
    // Parens are legal inside a quoted value (sub-delims) but outside them
    // they would be URL structure the predicate does not own.
    if (char === '(' || char === ')') return null;
    if (char === ',') {
      elements.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (inQuote) return null;
  elements.push(current);
  return elements;
}

/** Index of `target` outside quotes, or -1 (also -1 for an odd quote count). */
function indexOfUnquoted(text: string, target: string): number {
  let inQuote = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuote) {
      if (char === "'") {
        if (text[i + 1] === "'") {
          i += 1;
          continue;
        }
        inQuote = false;
      }
      continue;
    }
    if (char === "'") {
      inQuote = true;
      continue;
    }
    if (char === target) return i;
  }
  return -1;
}

/** Validate `(...)` against `keyPredicate = simpleKey / compoundKey`. */
function isValidKeyPredicate(predicate: string): boolean {
  // SQUOTE = "'" / "%27": the ABNF makes the two spellings one token, so a
  // `%27` can open, close, or (doubled) escape a quoted value. Normalising
  // first makes the quote-aware scanner see the tokens the decoder will:
  // `Parts('a%27b')` becomes `Parts('a'b')` and is rejected as unbalanced,
  // while `Parts('O%27%27Brien')` becomes `Parts('O''Brien')`.
  const normalized = predicate.replace(/%27/g, "'");
  if (normalized.length < 3 || !normalized.startsWith('(') || !normalized.endsWith(')')) {
    return false;
  }

  const elements = splitKeyElements(normalized.slice(1, -1));
  if (elements === null || elements.length === 0) return false;

  for (const element of elements) {
    if (element.length === 0) return false;
    const eq = indexOfUnquoted(element, '=');
    if (eq === -1) {
      // simpleKey: one positional value. compoundKey admits no positional
      // element, so with a comma present every element must be name=value —
      // positional and named cannot be mixed.
      if (elements.length > 1) return false;
      if (!isValidKeyValue(element)) return false;
      continue;
    }
    if (eq === 0 || !KEY_NAME.test(element.slice(0, eq))) return false;
    if (!isValidKeyValue(element.slice(eq + 1))) return false;
  }
  return true;
}

/**
 * Validate the single resource path segment the URL is built from (an entity
 * set name, or the entity type name the builder UI previews with).
 */
/**
 * The path part of a resource segment, without a key predicate.
 *
 * `/Parts('P1')` and `/Parts` address the same entity set, so metadata lookups
 * must use the path — otherwise a key predicate resolves to nothing and every
 * literal falls back to an inferred type.
 */
export function resourcePathOf(entitySet: string): string {
  const predicateStart = entitySet.indexOf('(');
  return predicateStart === -1 ? entitySet : entitySet.slice(0, predicateStart);
}

function assertResourceSegment(entitySet: string): string {
  if (!entitySet || entitySet.trim().length === 0) {
    throw new Error('entitySet is required');
  }

  const rejection = () =>
    new Error(
      `Invalid entitySet: ${JSON.stringify(entitySet)}. Expected a resource path of OData ` +
        'identifiers, optionally with a key predicate, e.g. "Parts", "Container/Parts" or ' +
        `"Parts('P1')".`,
    );

  // Split the path from an optional key predicate: `/Parts('P1')` addresses one
  // entity, and is the most common URL anyone types into an OData tool.
  const path = resourcePathOf(entitySet);
  const predicate = entitySet.slice(path.length);

  if (!path || path.startsWith('/') || path.endsWith('/')) throw rejection();

  // A container-qualified path (Container/EntitySet) is legitimate, so each
  // segment is checked on its own rather than rejecting "/" outright.
  for (const segment of path.split('/')) {
    if (!RESOURCE_SEGMENT.test(segment)) throw rejection();
  }

  if (predicate && !isValidKeyPredicate(predicate)) throw rejection();

  return entitySet;
}

function assertSelectItem(value: string): string {
  if (!SELECT_ITEM.test(value)) {
    throw new Error(`Invalid $select: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertIdentifier(value: string, label: string): string {
  if (!SIMPLE_IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertPropertyPath(value: string, label: string): string {
  if (!PROPERTY_PATH.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertNonNegativeInteger(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function isSortDirection(token: string): boolean {
  const lowered = token.toLowerCase();
  return lowered === 'asc' || lowered === 'desc';
}

/**
 * Build `$orderby`, which may name more than one field. Anything after the
 * direction used to be dropped silently, so `name desc junk` quietly produced
 * `name desc`; extra tokens are now an error instead.
 */
function buildOrderBy(orderBy: string): string {
  const clauses = orderBy
    .split(',')
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);

  if (clauses.length === 0) {
    throw new Error('Invalid $orderby: no sort field given');
  }

  return clauses
    .map((clause) => {
      const tokens = clause.split(/\s+/);
      if (tokens.length > 2) {
        throw new Error(`Invalid $orderby expression: ${JSON.stringify(clause)}`);
      }
      const [rawField, direction] = tokens;
      // A lone `asc`/`desc` is a direction with its field missing (e.g. the
      // caller sent " desc"), not a request to sort on a column named "desc".
      if (tokens.length === 1 && isSortDirection(rawField)) {
        throw new Error(`Invalid $orderby: missing sort field in ${JSON.stringify(clause)}`);
      }
      const field = assertPropertyPath(rawField, '$orderby field');
      if (direction && !isSortDirection(direction)) {
        throw new Error(`Invalid sort direction: ${direction}`);
      }
      return `${encodeQueryValue(field)}${direction ? ` ${direction.toLowerCase()}` : ''}`;
    })
    .join(',');
}

/** Split a comma-separated list, ignoring commas inside single-quoted values. */
function splitLiteralList(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inString = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (inString) {
      if (char === "'" && input[i + 1] === "'") {
        current += "''";
        i += 1;
        continue;
      }
      if (char === "'") inString = false;
      current += char;
      continue;
    }
    if (char === "'") {
      inString = true;
      current += char;
      continue;
    }
    if (char === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/**
 * Strip one layer of surrounding quotes and un-escape doubled quotes, so the
 * value round-trips back through `formatV4Literal`. A value that mixes quoted
 * and unquoted text cannot be a single literal and is rejected rather than
 * escaped into something that silently never matches.
 */
function unquoteLiteral(value: string, property: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.includes("'")) {
    throw new Error(
      `Invalid "in" list value for "${property}": ${JSON.stringify(value)}. ` +
        'Use a quoted string (Edm.String and enum values) or an unquoted literal.',
    );
  }
  return value;
}

/**
 * Build the parenthesised value list of an `in` comparison. The list used to be
 * spliced in verbatim, which both skipped literal typing and let a value such
 * as `1) or true or (1` inject extra filter logic.
 */
function buildInList(raw: string, edmType: string | undefined, property: string): string {
  const empty = () =>
    new Error(`The "in" operator on "${property}" requires a non-empty list of values.`);

  const trimmed = raw.trim();
  if (trimmed.length === 0) throw empty();

  let inner = trimmed;
  if (trimmed.startsWith('(')) {
    if (!trimmed.endsWith(')')) {
      throw new Error(`Unbalanced parentheses in "in" list for "${property}": ${trimmed}`);
    }
    inner = trimmed.slice(1, -1);
  }
  if (/[()]/.test(inner)) {
    throw new Error(`Unexpected parentheses in "in" list for "${property}": ${trimmed}`);
  }

  const elements = splitLiteralList(inner)
    .map((element) => element.trim())
    .filter((element) => element.length > 0);
  if (elements.length === 0) throw empty();

  return `(${elements
    .map((element) => formatV4Literal(unquoteLiteral(element, property), edmType))
    .join(',')})`;
}

/**
 * Validate every value in an `$expand` tree before any of it is emitted. This
 * runs once for the whole tree so nested segments are covered no matter which
 * branch of `buildExpand` produces them.
 */
function validateExpand(expands: ExpandNode[]): void {
  for (const item of expands) {
    assertIdentifier(item.navProperty, 'navigation property');
    for (const selected of item.select ?? []) {
      assertSelectItem(selected);
    }
    for (const clause of item.filters ?? []) {
      assertPropertyPath(clause.property, 'property');
    }
    if (item.orderBy && item.orderBy.trim().length > 0) {
      buildOrderBy(item.orderBy);
    }
    assertNonNegativeInteger(item.top, '$top');
    assertNonNegativeInteger(item.skip, '$skip');
    if (item.expand?.length) validateExpand(item.expand);
  }
}

/**
 * Build an OData V4 query URL (relative to the service root, or absolute
 * when baseUrl is given).
 */
export function buildQueryUrl(options: QueryOptions): string {
  const entitySet = assertResourceSegment(options.entitySet);

  if (
    options.search &&
    (options.filters?.length || options.top !== undefined || options.skip !== undefined)
  ) {
    throw new Error(
      'OData V4 does not allow $search together with $filter, $top, or $skip. Use $filter alone, or $search with $select/$orderby/$count.',
    );
  }

  const hasApply = Boolean(
    (options.groupBy && options.groupBy.length > 0) ||
    (options.aggregates && options.aggregates.length > 0),
  );

  if (hasApply && options.expand && options.expand.length > 0) {
    throw new Error('OData V4 does not allow $expand together with $apply.');
  }
  if (hasApply && options.search) {
    throw new Error('OData V4 does not allow $search together with $apply.');
  }

  const rootEntity = resolveRootEntity(options);
  const params: string[] = [];
  const warn = options.onWarning;
  const checkProperty = (property: string): void => {
    if (!warn || !rootEntity || !options.metadata) return;
    // `*`, `NS.*` and structural paths name something other than a single
    // property on the root type, so the exact-name check cannot apply to them.
    if (property.includes('*') || property.includes('/')) return;
    const entity = findEntityByName(options.metadata.entities, rootEntity);
    if (!entity) return;
    const known = getEffectiveProperties(entity, options.metadata.entities).some(
      (p) => p.name === property,
    );
    if (!known) {
      warn(`"${property}" is not a property of ${rootEntity}.`);
    }
  };

  for (const filter of options.filters ?? []) {
    assertPropertyPath(filter.property, 'property');
    checkProperty(filter.property);
  }

  for (const selected of options.select ?? []) {
    assertSelectItem(selected);
  }
  validateExpand(options.expand ?? []);

  if (hasApply) {
    // $apply must be the first system query option. Aliases are caller-supplied,
    // so the value goes through the same encoding as the other options.
    const apply = buildApply(options.groupBy, options.aggregates, rootEntity, options.metadata);
    params.push(`$apply=${encodeQueryValue(apply)}`);
  }

  for (const selected of options.select ?? []) {
    checkProperty(selected);
  }

  const filterStr = buildFilter(options.filters ?? [], options.filterLogic ?? 'and', (property) =>
    lookupPropertyType(rootEntity, property, options.metadata),
  );
  if (filterStr) params.push(`$filter=${encodeQueryValue(filterStr)}`);

  if (options.select && options.select.length > 0) {
    params.push(`$select=${options.select.map(encodeQueryValue).join(',')}`);
  }

  if (options.expand && options.expand.length > 0) {
    const expandStr = buildExpand(options.expand, rootEntity, options.metadata, warn, '');
    if (expandStr) params.push(`$expand=${encodeQueryValue(expandStr)}`);
  }

  if (options.orderBy && options.orderBy.trim().length > 0) {
    const orderBy = buildOrderBy(options.orderBy);
    for (const clause of options.orderBy.split(',')) {
      const field = clause.trim().split(/\s+/)[0];
      if (field) checkProperty(field);
    }
    params.push(`$orderby=${orderBy}`);
  }

  assertNonNegativeInteger(options.top, '$top');
  if (options.top !== undefined) {
    params.push(`$top=${options.top}`);
  }

  assertNonNegativeInteger(options.skip, '$skip');
  if (options.skip !== undefined) {
    params.push(`$skip=${options.skip}`);
  }

  if (options.count) {
    params.push('$count=true');
  }

  if (options.search) {
    params.push(`$search=${encodeQueryValue(options.search)}`);
  }

  const path = `/${entitySet}${params.length > 0 ? `?${params.join('&')}` : ''}`;
  if (options.baseUrl) {
    const base = options.baseUrl.replace(/\/+$/, '');
    return `${base}${path}`;
  }
  return path;
}

type TypeLookup = (property: string) => string | undefined;

/**
 * Build the `$apply` transformation: `groupby((A),aggregate(...))`, or a bare
 * `aggregate(...)` when no grouping is requested.
 */
function buildApply(
  groupBy: GroupByNode[] | undefined,
  aggregates: AggregateNode[] | undefined,
  rootEntity: string | undefined,
  metadata: ODataMetadata | undefined,
): string {
  const typeOf: TypeLookup = (property) => lookupPropertyType(rootEntity, property, metadata);

  const groupParts = (groupBy ?? []).map((group) => {
    const type = typeOf(group.property);
    if (!type && metadata && rootEntity) {
      throw new Error(`"${group.property}" is not a property of ${rootEntity}.`);
    }
    const alias = group.alias ? ` as ${group.alias}` : '';
    return `${group.property}${alias}`;
  });

  const aggregateParts = (aggregates ?? []).map((aggregate) => {
    if (aggregate.method === 'count') {
      const alias = aggregate.alias ?? 'count';
      return `$count as ${alias}`;
    }

    const property = aggregate.property;
    if (!property) {
      throw new Error(`Aggregate "${aggregate.method}" requires a property.`);
    }

    const type = typeOf(property);
    if (!type && metadata && rootEntity) {
      throw new Error(`"${property}" is not a property of ${rootEntity}.`);
    }
    if ((aggregate.method === 'sum' || aggregate.method === 'avg') && !isNumericEdmType(type)) {
      throw new Error(
        `Cannot ${aggregate.method} "${property}": ${aggregate.method} requires a numeric property (got ${type ?? 'unknown type'}).`,
      );
    }

    const alias = aggregate.alias ?? `${aggregate.method}_${property}`;
    return `${aggregate.method}(${property}) as ${alias}`;
  });

  const aggregateClause = aggregateParts.length > 0 ? `aggregate(${aggregateParts.join(',')})` : '';

  if (groupParts.length === 0) {
    if (!aggregateClause) {
      throw new Error('$apply requires at least one groupBy property or aggregate.');
    }
    return aggregateClause;
  }

  return `groupby((${groupParts.join(',')})${aggregateClause ? `,${aggregateClause}` : ''})`;
}

function isNumericEdmType(type: string | undefined): boolean {
  return type !== undefined && NUMERIC_TYPES.has(type);
}

function buildFilter(
  filters: FilterClause[],
  logic: 'and' | 'or',
  resolveType: TypeLookup,
): string {
  if (filters.length === 0) return '';

  const parts = filters.map((clause) => {
    const operator = clause.operator.toLowerCase();
    if (!ALLOWED_OPERATORS.has(operator)) {
      throw new Error(`Unsupported filter operator: ${clause.operator}`);
    }
    const edmType = resolveType(clause.property);

    if (STRING_FUNCTION_OPERATORS.has(operator)) {
      const literal = formatV4Literal(clause.value, 'Edm.String');
      return `${operator}(${clause.property},${literal})`;
    }

    if (operator === 'in') {
      return `${clause.property} in ${buildInList(clause.value, edmType, clause.property)}`;
    }

    const literal = formatV4Literal(clause.value, edmType ?? inferTypeFromValue(clause.value));
    return `${clause.property} ${operator} ${literal}`;
  });

  return parts.join(` ${logic} `);
}

function buildExpand(
  expands: ExpandNode[],
  parentEntityName: string | undefined,
  metadata: ODataMetadata | undefined,
  warn?: (message: string) => void,
  pathPrefix = '',
): string {
  if (expands.length === 0) return '';
  if (!metadata) {
    // Without metadata we can only emit bare paths / user-provided options.
    return expands
      .map((item) => {
        const nested = item.expand?.length
          ? buildExpand(item.expand, undefined, metadata, warn, `${pathPrefix}${item.navProperty}/`)
          : '';
        const parts: string[] = [];
        if (item.select?.length) parts.push(`$select=${item.select.join(',')}`);
        if (nested) parts.push(`$expand=${nested}`);
        if (item.orderBy) parts.push(`$orderby=${buildOrderBy(item.orderBy)}`);
        if (item.top !== undefined) parts.push(`$top=${item.top}`);
        if (item.skip !== undefined) parts.push(`$skip=${item.skip}`);
        if (item.filters?.length) {
          const filterStr = buildFilter(item.filters, item.filterLogic ?? 'and', () => undefined);
          if (filterStr) parts.push(`$filter=${filterStr}`);
        }
        return parts.length > 0 ? `${item.navProperty}(${parts.join(';')})` : item.navProperty;
      })
      .join(',');
  }

  return expands
    .map((item) => {
      const parts: string[] = [];
      const targetEntityName = resolveExpandTarget(parentEntityName, item.navProperty, metadata);

      if (parentEntityName && !targetEntityName && warn) {
        const parent = findEntityByName(metadata.entities, parentEntityName);
        const known = parent
          ? getEffectiveNavigationProperties(parent, metadata.entities).some(
              (n) => n.name === item.navProperty,
            )
          : false;
        if (!known) {
          warn(
            `"${pathPrefix}${item.navProperty}" is not a navigation property of ${parentEntityName}.`,
          );
        }
      }

      if (item.select?.length) {
        parts.push(`$select=${item.select.join(',')}`);
      }

      if (item.filters?.length) {
        const filterStr = buildFilter(item.filters, item.filterLogic ?? 'and', (property) =>
          lookupPropertyType(targetEntityName, property, metadata),
        );
        if (filterStr) parts.push(`$filter=${filterStr}`);
      }

      if (item.expand?.length) {
        const nested = buildExpand(
          item.expand,
          targetEntityName,
          metadata,
          warn,
          `${pathPrefix}${item.navProperty}/`,
        );
        if (nested) parts.push(`$expand=${nested}`);
      }

      if (item.orderBy) {
        parts.push(`$orderby=${buildOrderBy(item.orderBy)}`);
      }
      if (item.top !== undefined) {
        parts.push(`$top=${item.top}`);
      }
      if (item.skip !== undefined) {
        parts.push(`$skip=${item.skip}`);
      }

      return parts.length > 0 ? `${item.navProperty}(${parts.join(';')})` : item.navProperty;
    })
    .join(',');
}

function resolveRootEntity(options: QueryOptions): string | undefined {
  if (!options.metadata) return undefined;

  // The caller may know the entity type even when the path is not a set name.
  if (options.rootEntityName) {
    const direct = findEntityByName(options.metadata.entities, options.rootEntityName);
    if (direct) return direct.qualifiedName ?? direct.name;
  }

  // Look the set up by its *path*: a key predicate addresses one entity of the
  // same set, so `/Parts('P1')` must resolve exactly like `/Parts` or every
  // literal degrades to an inferred type and property warnings stop firing.
  const set = findEntitySet(options.metadata, resourcePathOf(options.entitySet));
  if (!set) return undefined;
  return set.entityTypeQualified ?? set.entityType;
}

function resolveExpandTarget(
  parentEntityName: string | undefined,
  navProperty: string,
  metadata: ODataMetadata,
): string | undefined {
  if (!parentEntityName) return undefined;
  const parent = findEntityByName(metadata.entities, parentEntityName);
  if (!parent) return undefined;
  const nav = getEffectiveNavigationProperties(parent, metadata.entities).find(
    (n) => n.name === navProperty,
  );
  if (!nav) return undefined;
  return nav.targetTypeQualified ?? nav.targetType;
}

function lookupPropertyType(
  entityName: string | undefined,
  property: string,
  metadata: ODataMetadata | undefined,
): string | undefined {
  if (!metadata || !entityName) return undefined;
  const entity = findEntityByName(metadata.entities, entityName);
  if (!entity) return undefined;
  const prop = getEffectiveProperties(entity, metadata.entities).find((p) => p.name === property);
  if (!prop) return undefined;
  return unwrapTypeDefinition(prop.type, metadata);
}

/** Follow TypeDefinition aliases to the underlying EDM type (enums stay as-is). */
function unwrapTypeDefinition(type: string, metadata: ODataMetadata): string {
  let current = type;
  const seen = new Set<string>();
  while (!current.startsWith('Edm.') && !seen.has(current)) {
    seen.add(current);
    const typeDef = metadata.typeDefinitions.find(
      (t) => t.qualifiedName === current || t.name === current,
    );
    if (!typeDef) break;
    current = typeDef.underlyingType;
  }
  return current;
}

function inferTypeFromValue(value: string): string {
  const raw = value.trim();
  if (raw === 'true' || raw === 'false') return 'Edm.Boolean';
  if (isNumericLiteral(raw)) return 'Edm.Double';
  if (raw.toLowerCase() === 'null') return 'Edm.String';
  return 'Edm.String';
}

function isNumericLiteral(raw: string): boolean {
  return /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw.trim());
}
