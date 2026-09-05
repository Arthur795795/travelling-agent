import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../../src/persistence/database.ts";
import { ShareRecordRepository } from "../../src/persistence/repositories.ts";
import { SharingService } from "../../src/sharing/service.ts";
import { sharingHttp } from "../../src/sharing/http.ts";
import { exportHttp } from "../../src/exports/http.ts";
import { executableTrip } from "../fixtures/executable-trip.ts";
test("share preview policy, unguessable tokens, field filtering, expiry and immediate deletion", async (t) => {
  let clock = new Date("2026-09-05T00:00:00Z");
  const now = () => clock;
  const db = openDatabase();
  t.after(() => db.close());
  const service = new SharingService(new ShareRecordRepository(db, now), now);
  const api = sharingHttp(service, () => true);
  const trip = executableTrip();
  trip.days[0].notes = ["private note"];
  trip.brief.hardConstraints = ["private constraint"];
  assert.equal(
    (
      await sharingHttp(service).create(
        new Request("http://local", { method: "POST" }),
      )
    ).status,
    403,
  );
  const created = await api.create(
    new Request("http://local", {
      method: "POST",
      body: JSON.stringify({
        trip,
        fields: { budget: false, privateNotes: false },
        confirmed: true,
      }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.match(body.readUrl, /^\/share\/[a-f0-9]{64}$/);
  assert.match(body.deleteToken, /^[a-f0-9]{64}$/);
  assert.notEqual(body.readUrl.split("/").at(-1), body.deleteToken);
  const read = await api.read(body.readUrl.split("/").at(-1));
  assert.equal(read.status, 200);
  assert.match(read.headers.get("X-Robots-Tag")!, /noindex/);
  assert.doesNotMatch(
    await read.text(),
    /private note|private constraint|"amount":60/,
  );
  assert.equal(api.delete(body.readUrl.split("/").at(-1)).status, 404);
  assert.equal(api.delete(body.deleteToken).status, 204);
  assert.equal(api.read(body.readUrl.split("/").at(-1)).status, 404);
  const second = service.create(trip);
  clock = new Date("2026-10-06T00:00:00Z");
  assert.equal(service.read(second.readToken), null);
});
test("export endpoints honor flags, fields, headers and stable failures", async () => {
  const trip = executableTrip();
  const disabled = await exportHttp()(
    new Request("http://local", { method: "POST" }),
    trip.id,
    "ics",
  );
  assert.equal(disabled.status, 403);
  const api = exportHttp(
    () => true,
    async () => Buffer.from("%PDF-mock"),
  );
  const request = () =>
    new Request("http://local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trip,
        fields: { budget: false, privateNotes: false },
      }),
    });
  const ics = await api(request(), trip.id, "ics");
  assert.equal(ics.headers.get("Content-Type"), "text/calendar; charset=utf-8");
  assert.match(await ics.text(), /AI 辅助生成/);
  const pdf = await api(request(), trip.id, "pdf");
  assert.equal(pdf.headers.get("Content-Type"), "application/pdf");
  assert.equal(await pdf.text(), "%PDF-mock");
  const failed = await exportHttp(
    () => true,
    async () => {
      throw new Error("secret path");
    },
  )(request(), trip.id, "pdf");
  assert.equal(failed.status, 422);
  assert.doesNotMatch(await failed.text(), /secret path/);
});
