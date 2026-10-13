// Gramps 6 enum values the projection reads (gramps/gen/lib). Only the values the allowlist needs.

/** Enums serialize as a bare integer or as `{ _class, value, string }`. Returns the integer or null. */
export function enumValue(x) {
  if (typeof x === 'number' && Number.isInteger(x)) return x;
  if (x && typeof x === 'object' && Number.isInteger(x.value)) return x.value;
  return null;
}

/** The free-text half of a custom enum, used only to classify (never emitted). */
export function enumString(x) {
  return x && typeof x === 'object' && typeof x.string === 'string' ? x.string : '';
}

export const GENDER = { FEMALE: 0, MALE: 1, UNKNOWN: 2, OTHER: 3 };

export const DATE_MODIFIER = { NONE: 0, BEFORE: 1, AFTER: 2, ABOUT: 3, RANGE: 4, SPAN: 5, TEXTONLY: 6 };
export const DATE_QUALITY = { REGULAR: 0, ESTIMATED: 1, CALCULATED: 2 };

export const EVENT_ROLE = { UNKNOWN: -1, CUSTOM: 0, PRIMARY: 1, CLERGY: 2, CELEB: 3, AIDE: 4, BRIDE: 5, GROOM: 6, WITNESS: 7, FAMILY: 8, INFORMANT: 9 };
/** Roles whose events describe the person themself (viz.md section 5.2). */
export const ROLE_ALLOWLIST = new Set([EVENT_ROLE.PRIMARY, EVENT_ROLE.FAMILY, EVENT_ROLE.BRIDE, EVENT_ROLE.GROOM]);

// EventType values -> the output vocabulary. Anything else becomes "other".
export const EVENT_TYPE_NAMES = new Map([
  [1, 'marriage'],
  [7, 'divorce'],
  [12, 'birth'],
  [13, 'death'],
  [19, 'burial'],
  [25, 'degree'],
  [26, 'education'],
  [28, 'emigration'],
  [30, 'immigration'],
  [31, 'graduation'],
  [33, 'military_serv'],
  [37, 'occupation'],
  [42, 'residence'],
]);
export const EVENT_TYPES = ['birth', 'death', 'burial', 'marriage', 'divorce', 'residence', 'education', 'graduation', 'degree', 'military_serv', 'emigration', 'immigration', 'occupation', 'other'];

export const FAMILY_REL_NAMES = new Map([
  [0, 'married'],
  [1, 'unmarried'],
  [2, 'civil_union'],
  [3, 'unknown'],
  [4, 'custom'],
]);
export const UNION_TYPES = ['married', 'unmarried', 'civil_union', 'unknown', 'custom'];

export const CHILD_REL_NAMES = new Map([
  [0, 'none'],
  [1, 'birth'],
  [2, 'adopted'],
  [3, 'step'],
  [4, 'sponsored'],
  [5, 'foster'],
  [6, 'unknown'],
  [7, 'custom'],
]);
export const CHILD_RELS = ['birth', 'adopted', 'step', 'sponsored', 'foster', 'unknown', 'none', 'custom'];

// PlaceType values.
export const PLACE_TYPE_NAMES = new Map([
  [-1, 'unknown'],
  [0, 'custom'],
  [1, 'country'],
  [2, 'state'],
  [3, 'county'],
  [4, 'city'],
  [5, 'parish'],
  [6, 'locality'],
  [8, 'province'],
  [9, 'region'],
  [10, 'department'],
  [12, 'district'],
  [13, 'borough'],
  [14, 'municipality'],
  [15, 'town'],
  [16, 'village'],
  [17, 'hamlet'],
]);
export const PLACE_TYPES = ['unknown', 'custom', 'country', 'state', 'county', 'city', 'parish', 'locality', 'province', 'region', 'department', 'district', 'borough', 'municipality', 'town', 'village', 'hamlet'];
/** Street 7, Neighborhood 11, Farm 18, Building 19, Number 20: never emitted (rule S). */
export const ADDRESS_GRADE_PLACE_TYPES = new Set([7, 11, 18, 19, 20]);
/** A custom place type that names a home or an address is treated the same way (PS-15). */
export const HOME_LIKE_CUSTOM = /(home|house|address|residence|street|apartment|farm|building|ranch|cabin|estate|lot|neighbo)/i;
/**
 * A place NAME that reads as a street address ("12 Elm Street"), whatever its PlaceType says. Conservative on
 * purpose: a false positive only collapses the place to its parent (with a warning), never leaks it.
 */
export const ADDRESS_LIKE_NAME = /^\s*\d{1,6}[a-z]?\s+\S|\S\s+(?:street|road|avenue|lane|drive|boulevard|highway|parkway|terrace|ave|blvd|hwy|rd|ln)\b|\S\s+st\.?\s*$/i;
/** Event types a LIVING person keeps (VIZ-D5). Every other type is dropped for the living. */
export const LIVING_EVENT_KEEP = new Set(['birth', 'marriage', 'divorce', 'education', 'graduation', 'degree']);
