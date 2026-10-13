// Error catalog for the graph builder (viz.md section 17). Messages never carry a data value:
// they name a class, a field or a JSON pointer, and nothing the family typed.

export const EXIT = Object.freeze({
  OK: 0,
  GENERIC: 1,
  INPUT_MISSING: 2,
  SIZE_BUDGET: 3,
  PRIVACY_VIOLATION: 4,
  LIVING_MISMATCH: 5,
  GRAMPS_OPEN: 6,
  SNAPSHOT_SHAPE: 7,
  GAZETTEER_CHECKSUM: 8,
});

export class GraphError extends Error {
  /**
   * @param {keyof typeof EXIT} code  one of the section 17 codes
   * @param {string} message          operator message, no data values
   * @param {object} [extra]          `pointers` (JSON pointers) or `ids` (gramps ids), both value-free
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'GraphError';
    this.code = code;
    this.exitCode = EXIT[code] ?? EXIT.GENERIC;
    this.pointers = extra.pointers ?? [];
    this.ids = extra.ids ?? [];
  }
}
