// HFY-TSK-158 (relationship-wizard-island): the wizard's calls (src/lib/wizard-api.js) against a fake API client. Synthetic ids only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWizardApi, nameOfObj, newKey } from "../src/lib/wizard-api.js";

const person = (first, surname, extra = {}) => ({ _class: "Person", primary_name: { first_name: first, surname_list: [{ surname }] }, ...extra });
const RECORDS = {
  "Person/hsyn0001": { handle: "hsyn0001", gramps_id: "I9001", obj: person("Me", "Example", { parent_family_list: ["hf1"], family_list: ["hf2"] }) },
  "Person/hsyn0002": { handle: "hsyn0002", gramps_id: "I9002", obj: person("Tessa", "Example") },
  "Person/hsyn0003": { handle: "hsyn0003", gramps_id: "I9003", obj: person("Orrin", "Example") },
  "Person/hsyn0005": { handle: "hsyn0005", gramps_id: "I9005", obj: person("Alex", "Example") },
  "Person/hsyn0004": { handle: "hsyn0004", gramps_id: "I9004", obj: person("Sam", "Example") },
  "Family/hf1": { handle: "hf1", gramps_id: "F9001", obj: { father_handle: "hsyn0003", mother_handle: "hsyn0002", child_ref_list: [{ ref: "hsyn0001" }] } },
  "Family/hf2": { handle: "hf2", gramps_id: "F9002", obj: { father_handle: "", mother_handle: "hsyn0005", child_ref_list: [{ ref: "hsyn0004" }, { ref: "hsyn0001" }] } },
};
const fake = () => {
  const calls = [];
  const api = {
    calls,
    async get(path) {
      calls.push(["GET", path]);
      if (path.startsWith("/records/Person/by-id/")) {
        const gid = decodeURIComponent(path.split("/").pop());
        const hit = Object.values(RECORDS).find((r) => r.gramps_id === gid && r.obj.primary_name);
        if (!hit) throw Object.assign(new Error("nf"), { status: 404 });
        return hit;
      }
      const m = /^\/records\/(\w+)\/(\w+)$/.exec(path);
      if (m && RECORDS[`${m[1]}/${m[2]}`]) return { class: m[1], ...RECORDS[`${m[1]}/${m[2]}`] };
      if (path.startsWith("/edit/Person/")) return { key: "Person:hsyn0001", related: { "Place:hp1": { obj: { name: { value: "Springfield" } } }, "Event:he1": { obj: {} } } };
      throw Object.assign(new Error("nf"), { status: 404 });
    },
    async post(path, body, opts) { calls.push(["POST", path, body, opts]); return api.reply ? api.reply(path, body) : {}; },
  };
  return api;
};

describe("wizard api (AC1)", () => {
  it("preview sends the intent and only sends confirmDistinct when something is confirmed", async () => {
    const api = fake();
    api.reply = () => ({ summary: [{ text: "adds Tessa" }], duplicates: [{ for: "new:1", candidates: [{ handle: "h", displayName: "X", lifespan: "" }] }], warnings: [], followUps: [] });
    const w = createWizardApi({ api });
    const intent = { type: "parents", person: "Person:hsyn0001", parents: [] };
    const a = await w.preview(intent, []);
    assert.deepEqual(api.calls[0], ["POST", "/relationships/preview", { intent }, undefined]);
    assert.equal(a.view.duplicates.length, 1);
    await w.preview(intent, ["new:1"]);
    assert.deepEqual(api.calls[1][2], { intent, confirmDistinct: ["new:1"] });
  });
  it("an unconfirmed_duplicate answer from the gate is read like a report", async () => {
    const api = fake();
    api.post = async () => { throw Object.assign(new Error("x"), { status: 422, code: "unconfirmed_duplicate", details: { unconfirmed: ["new:2"], candidates: [{ for: "new:2", candidates: [{ handle: "h" }] }] } }); };
    const r = await createWizardApi({ api }).preview({}, ["new:1"]);
    assert.equal(r.error, null);
    assert.equal(r.view.duplicates[0].for, "new:2");
  });
  it("any other failure comes back as the error, never thrown", async () => {
    const api = fake();
    api.post = async () => { throw Object.assign(new Error("x"), { status: 422, code: "cycle" }); };
    const r = await createWizardApi({ api }).preview({}, []);
    assert.equal(r.view, null);
    assert.equal(r.error.code, "cycle");
  });
  it("send posts the intent, confirmDistinct and the Idempotency-Key header", async () => {
    const api = fake();
    api.reply = () => ({ proposal: { id: "P1" } });
    const out = await createWizardApi({ api }).send({ type: "unlink" }, ["new:1"], "key-1");
    assert.deepEqual(api.calls[0], ["POST", "/relationships", { intent: { type: "unlink" }, confirmDistinct: ["new:1"] }, { headers: { "Idempotency-Key": "key-1" } }]);
    assert.deepEqual(out, { proposal: { id: "P1" } });
    assert.match(newKey(), /^[0-9a-f-]{16,}$/);
    assert.notEqual(newKey(), newKey());
  });
});

describe("wizard lookups", () => {
  it("resolves a Gramps id to the handle the intent names; a missing person is null", async () => {
    const w = createWizardApi({ api: fake() });
    assert.deepEqual(await w.resolvePerson("I9002"), { handle: "hsyn0002", gid: "I9002", name: "Tessa Example" });
    assert.equal(await w.resolvePerson("I9999"), null);
  });
  it("loads the member's families with names and ids, and the partners for the other-parent list", async () => {
    const api = fake();
    const w = createWizardApi({ api });
    const { families, partners } = await w.loadFamily("hsyn0001");
    assert.deepEqual(families.map((f) => [f.handle, f.meAs]), [["hf1", "child"], ["hf2", "partner"]]);
    assert.deepEqual(families[0].parents.map((p) => p.name), ["Orrin Example", "Tessa Example"]);
    assert.deepEqual(families[1].parents.map((p) => p.gid), ["I9005"]);
    assert.deepEqual(families[1].children.map((p) => p.name), ["Sam Example"], "the member is not their own child");
    assert.deepEqual(partners.map((p) => p.handle), ["hsyn0005"]);
    const before = api.calls.length;
    await w.loadFamily("hsyn0001");
    assert.equal(api.calls.length, before, "asked once");
  });
  it("offers the places the member's page holds, as Place references", async () => {
    const w = createWizardApi({ api: fake() });
    assert.deepEqual(await w.loadPlaces("I9001"), [{ ref: "Place:hp1", name: "Springfield" }]);
  });
  it("names come from the Gramps object", () => {
    assert.equal(nameOfObj(person("Ann", "Example")), "Ann Example");
    assert.equal(nameOfObj(null), "");
  });
});
