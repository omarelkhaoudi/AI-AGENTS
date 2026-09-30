import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CALENDAR_EXCLUDED_STATUSES,
  InMemoryRepository,
  PUBLICATION_CALENDAR_TIME_ZONE,
  PrismaRepository,
  PublicationCalendarError,
  buildPublicationCalendar,
  cancelPublication,
  createPublication,
  localSlotOf,
  markPublicationPublished,
  prepareAndSubmitPublication,
  preparePublication,
  readPublicationCalendar,
  recordPublicationDecision,
  requestPublicationApproval,
  resolveCalendarWindow,
  schedulePublication
} from "../src/index.js";

// Business time is Africa/Casablanca: UTC+1, and UTC+0 during Ramadan. Both
// sides of that change are exercised below on real dates the runtime resolves,
// not on an offset assumed once.
const WEEK = Object.freeze({ from: "2026-10-05", to: "2026-10-09" });
const NOW = "2026-10-01T08:00:00.000Z";

// Two publications planned at the same instant on one channel: 10:00 business
// time on Tuesday 6 October, which is 09:00 UTC.
const TUESDAY_TEN = "2026-10-06T09:00:00.000Z";
const WEDNESDAY_NINE = "2026-10-07T08:00:00.000Z";

function draft(overrides = {}) {
  return {
    channel: "instagram",
    caption: "Nouvelle chambre enfant livrée à Casablanca.",
    hashtags: ["HKids"],
    authorAgentId: "community_manager",
    ...overrides
  };
}

async function planned(repository, overrides = {}) {
  return createPublication(repository, draft(overrides));
}

function ids(calendar) {
  return calendar.entries.map((entry) => entry.publicationId);
}

test("a publication planned inside the window is on the calendar", async () => {
  const repository = new InMemoryRepository();
  const publication = await planned(repository, { scheduledAt: TUESDAY_TEN });

  const calendar = await readPublicationCalendar(repository, WEEK);

  assert.deepEqual(ids(calendar), [publication.id]);
  assert.equal(calendar.timeZone, PUBLICATION_CALENDAR_TIME_ZONE);
  assert.equal(calendar.entries[0].localDate, "2026-10-06");
  assert.equal(calendar.entries[0].localTime, "10:00", "09:00 UTC is 10:00 in Casablanca");
  assert.equal(calendar.entries[0].status, "draft");
  assert.equal(calendar.entries[0].conflict, false);
  assert.deepEqual(calendar.conflicts, []);
});

test("a publication outside the window, or with no date, is not on it", async () => {
  const repository = new InMemoryRepository();
  const inside = await planned(repository, { scheduledAt: TUESDAY_TEN });
  await planned(repository, { scheduledAt: "2026-10-20T09:00:00.000Z" });
  await planned(repository, { scheduledAt: "2026-09-20T09:00:00.000Z" });
  await planned(repository);

  const calendar = await readPublicationCalendar(repository, WEEK);

  assert.deepEqual(ids(calendar), [inside.id]);
  // The window is business time: a post at 23:30 UTC on 9 October is already
  // 10 October in Casablanca and falls outside the week.
  const late = await planned(repository, { scheduledAt: "2026-10-09T23:30:00.000Z" });
  assert.equal(localSlotOf(late.scheduledAt), "2026-10-10T00:30");
  assert.deepEqual(ids(await readPublicationCalendar(repository, WEEK)), [inside.id]);
});

test("the calendar filters by channel", async () => {
  const repository = new InMemoryRepository();
  const instagram = await planned(repository, { scheduledAt: TUESDAY_TEN });
  const facebook = await planned(repository, { channel: "facebook", scheduledAt: WEDNESDAY_NINE });

  assert.deepEqual(ids(await readPublicationCalendar(repository, { ...WEEK, channel: "instagram" })), [instagram.id]);
  assert.deepEqual(ids(await readPublicationCalendar(repository, { ...WEEK, channel: "facebook" })), [facebook.id]);
  assert.deepEqual(ids(await readPublicationCalendar(repository, WEEK)).sort(), [instagram.id, facebook.id].sort());
  await assert.rejects(readPublicationCalendar(repository, { ...WEEK, channel: "threads" }), {
    code: "PUBLICATION_CALENDAR_CHANNEL_UNKNOWN"
  });
});

test("the calendar is ordered by date, whatever order the rows come in", async () => {
  const repository = new InMemoryRepository();
  const wednesday = await planned(repository, { scheduledAt: WEDNESDAY_NINE });
  const thursday = await planned(repository, { scheduledAt: "2026-10-08T07:00:00.000Z" });
  const tuesday = await planned(repository, { scheduledAt: TUESDAY_TEN });

  const calendar = await readPublicationCalendar(repository, WEEK);

  assert.deepEqual(ids(calendar), [tuesday.id, wednesday.id, thursday.id]);
  assert.deepEqual(
    calendar.entries.map((entry) => entry.localTime),
    ["10:00", "09:00", "08:00"]
  );
});

test("cancelled and rejected publications leave the calendar without leaving storage", async () => {
  const repository = new InMemoryRepository();
  const kept = await planned(repository, { scheduledAt: TUESDAY_TEN });

  const toCancel = await planned(repository, { scheduledAt: WEDNESDAY_NINE });
  await cancelPublication(repository, toCancel.id, { reason: "Report" });

  const toReject = await planned(repository, { scheduledAt: "2026-10-08T07:00:00.000Z" });
  await preparePublication(repository, toReject.id);
  const { approval } = await requestPublicationApproval(repository, toReject.id);
  await repository.rejectApproval(approval.id, { approverId: "leader-1", decisionReason: "Photo à refaire." });
  await recordPublicationDecision(repository, toReject.id);

  const calendar = await readPublicationCalendar(repository, WEEK);

  assert.deepEqual(ids(calendar), [kept.id]);
  assert.deepEqual([...CALENDAR_EXCLUDED_STATUSES], ["cancelled", "rejected"]);
  // Still stored, still readable: they are off the calendar, not deleted.
  assert.equal((await repository.getPublication(toCancel.id)).status, "cancelled");
  assert.equal((await repository.getPublication(toReject.id)).status, "rejected");
  assert.equal((await repository.listPublications()).length, 3);
});

test("an unusable window is refused", async () => {
  const repository = new InMemoryRepository();

  for (const window of [
    { from: "2026-10-09", to: "2026-10-05" },
    { from: "2026-10-09T10:00:00.000Z", to: "2026-10-09T09:00:00.000Z" }
  ]) {
    assert.throws(() => resolveCalendarWindow(window), (error) => {
      assert.ok(error instanceof PublicationCalendarError);
      assert.equal(error.code, "PUBLICATION_CALENDAR_WINDOW_INVALID");
      return true;
    });
  }

  for (const window of [{ to: "2026-10-09" }, { from: "2026-10-05" }, { from: "", to: "2026-10-09" }]) {
    assert.throws(() => resolveCalendarWindow(window), { code: "PUBLICATION_CALENDAR_WINDOW_INVALID" });
  }

  for (const window of [{ from: "mardi prochain", to: "2026-10-09" }, { from: "2026-10-05", to: 20261009 }]) {
    assert.throws(() => resolveCalendarWindow(window), { code: "PUBLICATION_CALENDAR_DATE_INVALID" });
  }

  await assert.rejects(readPublicationCalendar(repository, { from: "2026-10-09", to: "2026-10-05" }), {
    code: "PUBLICATION_CALENDAR_WINDOW_INVALID"
  });
});

test("a new slot in the past is refused, and refuses before writing anything", async () => {
  const repository = new InMemoryRepository();
  const publication = await planned(repository);

  await assert.rejects(
    prepareAndSubmitPublication(repository, publication.id, { scheduledAt: "2026-09-15T09:00:00.000Z", now: NOW }),
    (error) => {
      assert.ok(error instanceof PublicationCalendarError);
      assert.equal(error.code, "PUBLICATION_SCHEDULE_IN_PAST");
      assert.equal(error.details.localSlot, "2026-09-15T10:00");
      return true;
    }
  );

  assert.equal((await repository.getPublication(publication.id)).status, "draft", "the publication was not touched");
  assert.deepEqual(await repository.listApprovals(), [], "nothing was submitted");

  // The same instant is accepted once it is the present.
  const accepted = await prepareAndSubmitPublication(repository, publication.id, {
    scheduledAt: "2026-09-15T09:00:00.000Z",
    now: "2026-09-15T08:00:00.000Z"
  });
  assert.equal(accepted.publication.status, "pending_approval");
});

test("a past period stays readable: history is read, not planned", async () => {
  const repository = new InMemoryRepository();
  const past = await planned(repository, { scheduledAt: "2026-08-12T09:00:00.000Z" });
  await planned(repository, { scheduledAt: TUESDAY_TEN });

  const history = await readPublicationCalendar(repository, { from: "2026-08-01", to: "2026-08-31" });

  assert.deepEqual(ids(history), [past.id]);
  assert.equal(history.entries[0].localDate, "2026-08-12");
});

test("two publications on one channel at one slot are reported, not refused", async () => {
  const repository = new InMemoryRepository();
  const first = await planned(repository, { scheduledAt: TUESDAY_TEN, caption: "Version A." });
  const second = await planned(repository, { scheduledAt: TUESDAY_TEN, caption: "Version B." });
  const alone = await planned(repository, { scheduledAt: WEDNESDAY_NINE });

  const calendar = await readPublicationCalendar(repository, WEEK);

  assert.equal(calendar.entries.length, 3, "both publications are kept");
  assert.deepEqual(calendar.conflicts.length, 1);
  assert.equal(calendar.conflicts[0].channel, "instagram");
  assert.equal(calendar.conflicts[0].slot, "2026-10-06T10:00");
  assert.deepEqual([...calendar.conflicts[0].publicationIds].sort(), [first.id, second.id].sort());

  const flagged = calendar.entries.filter((entry) => entry.conflict).map((entry) => entry.publicationId);
  assert.deepEqual(flagged.sort(), [first.id, second.id].sort());
  assert.equal(calendar.entries.find((entry) => entry.publicationId === alone.id).conflict, false);
  assert.equal(calendar.slots.length, 2, "one slot per channel and time");
});

test("the same slot on two channels is not a conflict", async () => {
  const repository = new InMemoryRepository();
  await planned(repository, { scheduledAt: TUESDAY_TEN });
  await planned(repository, { channel: "facebook", scheduledAt: TUESDAY_TEN });
  await planned(repository, { channel: "linkedin", scheduledAt: TUESDAY_TEN });

  const calendar = await readPublicationCalendar(repository, WEEK);

  assert.equal(calendar.entries.length, 3);
  assert.deepEqual(calendar.conflicts, []);
  assert.equal(calendar.slots.length, 3);
  assert.ok(calendar.entries.every((entry) => entry.conflict === false));
});

test("business time follows Morocco, including the Ramadan change", async () => {
  // Casablanca runs at UTC+1, and at UTC+0 for Ramadan. The runtime holds those
  // rules; the calendar must not assume one offset for the year.
  assert.deepEqual(resolveCalendarWindow({ from: "2027-04-15", to: "2027-04-15" }), {
    from: "2027-04-14T23:00:00.000Z",
    to: "2027-04-15T22:59:59.999Z"
  });
  assert.deepEqual(resolveCalendarWindow({ from: "2027-02-20", to: "2027-02-20" }), {
    from: "2027-02-20T00:00:00.000Z",
    to: "2027-02-20T23:59:59.999Z"
  });

  assert.equal(localSlotOf("2027-04-15T09:00:00.000Z"), "2027-04-15T10:00");
  assert.equal(localSlotOf("2027-02-20T09:00:00.000Z"), "2027-02-20T09:00");

  const repository = new InMemoryRepository();
  const ramadan = await planned(repository, { scheduledAt: "2027-02-20T09:00:00.000Z" });
  const spring = await planned(repository, { scheduledAt: "2027-04-15T09:00:00.000Z" });

  // One window across the change: both are in it, each read at its own offset.
  const calendar = await readPublicationCalendar(repository, { from: "2027-02-01", to: "2027-04-30" });

  assert.deepEqual(ids(calendar), [ramadan.id, spring.id]);
  assert.deepEqual(
    calendar.entries.map((entry) => entry.localTime),
    ["09:00", "10:00"]
  );
  // Same instant of the day in UTC on both sides of the change, two different
  // readings in business time: that is the offset actually moving.
  assert.equal(new Date(calendar.entries[0].scheduledAt).getUTCHours(), 9);
  assert.equal(new Date(calendar.entries[1].scheduledAt).getUTCHours(), 9);
  assert.notEqual(calendar.entries[0].localTime, calendar.entries[1].localTime);
});

test("preparing, dating and submitting is one operation and one approval", async () => {
  const repository = new InMemoryRepository();
  const publication = await planned(repository);

  const { publication: pending, approval } = await prepareAndSubmitPublication(repository, publication.id, {
    scheduledAt: TUESDAY_TEN,
    caption: "Version soumise à Hiba.",
    hashtags: ["HKids", "#chambre_enfant"],
    now: NOW,
    reason: "Publication Instagram à valider avant diffusion."
  });

  assert.equal(pending.status, "pending_approval");
  assert.equal(pending.scheduledAt, TUESDAY_TEN);
  assert.equal(pending.caption, "Version soumise à Hiba.");
  assert.deepEqual([...pending.hashtags], ["HKids", "chambre_enfant"]);
  assert.equal(pending.approvalId, approval.id);

  const approvals = await repository.listApprovals();
  assert.equal(approvals.length, 1, "exactly one approval");
  assert.equal(approvals[0].requestedAction, "publish_social_publication");
  assert.equal(approvals[0].metadata.publicationId, publication.id);
  assert.equal((await repository.listPendingApprovals()).length, 1);

  // Submitted work stays on the calendar while it waits for Hiba.
  assert.deepEqual(ids(await readPublicationCalendar(repository, WEEK)), [publication.id]);
});

test("a submission that cannot proceed creates no approval", async () => {
  const repository = new InMemoryRepository();
  const publication = await planned(repository);
  await prepareAndSubmitPublication(repository, publication.id, { scheduledAt: TUESDAY_TEN, now: NOW });

  // Already waiting on a human: submitting again is refused, and the queue does
  // not grow a second entry for the same publication.
  await assert.rejects(
    prepareAndSubmitPublication(repository, publication.id, { scheduledAt: WEDNESDAY_NINE, now: NOW }),
    { code: "PUBLICATION_TRANSITION_REFUSED" }
  );

  assert.equal((await repository.listApprovals()).length, 1);
  assert.equal((await repository.getPublication(publication.id)).status, "pending_approval");
  assert.equal((await repository.getPublication(publication.id)).scheduledAt, TUESDAY_TEN);

  // A draft with no usable slot is refused before the approval system is asked
  // for anything.
  const second = await planned(repository);
  await assert.rejects(prepareAndSubmitPublication(repository, second.id, { scheduledAt: null, now: NOW }), {
    code: "PUBLICATION_CALENDAR_DATE_INVALID"
  });
  assert.equal((await repository.listApprovals()).length, 1);
  assert.equal((await repository.getPublication(second.id)).status, "draft");
});

test("after Hiba approves, the publication stays on the calendar through to published", async () => {
  const repository = new InMemoryRepository();
  const publication = await planned(repository);
  const { approval } = await prepareAndSubmitPublication(repository, publication.id, {
    scheduledAt: TUESDAY_TEN,
    now: NOW
  });

  await repository.approveApproval(approval.id, { approverId: "leader-1", decisionReason: "Validé par Hiba." });
  const approved = await recordPublicationDecision(repository, publication.id);
  const scheduled = await schedulePublication(repository, publication.id);

  assert.equal(approved.status, "approved");
  assert.equal(scheduled.status, "scheduled");
  assert.equal(scheduled.scheduledAt, TUESDAY_TEN, "the calendar slot survives the approval");

  const calendar = await readPublicationCalendar(repository, WEEK);
  assert.deepEqual(ids(calendar), [publication.id]);
  assert.equal(calendar.entries[0].status, "scheduled");

  // And once sent by hand, it is still the history of that slot.
  await markPublicationPublished(repository, publication.id, { externalId: "ig-42" });
  const after = await readPublicationCalendar(repository, WEEK);
  assert.equal(after.entries[0].status, "published");
});

test("the calendar reaches no social network", async () => {
  const source = readFileSync(new URL("../src/social/publication-calendar.js", import.meta.url), "utf8")
    .replace(/^\s*\/\/.*$/gm, "");

  for (const forbidden of ["fetch(", "http", "n8n", "oauth", "token", "setTimeout", "setInterval", "cron"]) {
    assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()), `unexpected ${forbidden} in the calendar`);
  }

  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("The calendar must not call any network.");
  };

  try {
    const repository = new InMemoryRepository();
    const publication = await planned(repository);
    await prepareAndSubmitPublication(repository, publication.id, { scheduledAt: TUESDAY_TEN, now: NOW });
    const calendar = await readPublicationCalendar(repository, WEEK);

    assert.deepEqual(ids(calendar), [publication.id]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the builder works on rows alone, with no repository in sight", () => {
  const rows = [
    { id: "b", channel: "instagram", status: "approved", caption: "B", scheduledAt: new Date(TUESDAY_TEN) },
    { id: "a", channel: "instagram", status: "prepared", caption: "A", scheduledAt: TUESDAY_TEN },
    { id: "c", channel: "instagram", status: "cancelled", caption: "C", scheduledAt: TUESDAY_TEN }
  ];

  // PostgreSQL hands dates back as Date objects; the calendar reads both shapes.
  const calendar = buildPublicationCalendar(rows, WEEK);

  assert.deepEqual(ids(calendar), ["a", "b"]);
  assert.equal(calendar.conflicts.length, 1);
  assert.ok(calendar.entries.every((entry) => entry.scheduledAt === TUESDAY_TEN));
});

test("a publication already prepared is dated by the submission itself", async () => {
  const repository = new InMemoryRepository();
  const publication = await createPublication(repository, draft({ scheduledAt: WEDNESDAY_NINE }));

  // Prepared yesterday, on a slot that is no longer the right one.
  await preparePublication(repository, publication.id);
  assert.equal((await repository.getPublication(publication.id)).status, "prepared");
  assert.equal((await repository.getPublication(publication.id)).scheduledAt, WEDNESDAY_NINE);

  // Nothing prepares it a second time, so the new slot can only reach the
  // record through the changes the submission carries.
  const { publication: pending, approval } = await prepareAndSubmitPublication(repository, publication.id, {
    scheduledAt: TUESDAY_TEN,
    now: NOW
  });

  assert.equal(pending.status, "pending_approval");
  assert.equal(pending.scheduledAt, TUESDAY_TEN, "the slot given at submission is the one stored");
  assert.notEqual(pending.scheduledAt, WEDNESDAY_NINE, "the old slot was replaced");
  assert.equal((await repository.getPublication(publication.id)).scheduledAt, TUESDAY_TEN);

  const approvals = await repository.listApprovals();
  assert.equal(approvals.length, 1, "exactly one approval");
  assert.equal(approvals[0].id, approval.id);
  assert.equal(approvals[0].id, pending.approvalId);
  assert.equal(approvals[0].metadata.publicationId, publication.id);
  assert.equal(approvals[0].affectedResource, `publication:${publication.id}`);
  assert.equal((await repository.listPendingApprovals()).length, 1, "no second approval");

  // And the calendar shows it on the new slot, not the old one.
  const calendar = await readPublicationCalendar(repository, WEEK);
  assert.deepEqual(ids(calendar), [publication.id]);
  assert.equal(calendar.entries[0].slot, "2026-10-06T10:00");
});

test("the submission carries its slot through requestPublicationApproval itself", async () => {
  const repository = new InMemoryRepository();
  const publication = await createPublication(repository, draft());
  await preparePublication(repository, publication.id);

  const { publication: pending, approval } = await requestPublicationApproval(repository, publication.id, {
    changes: { scheduledAt: TUESDAY_TEN, caption: "Légende revue à la soumission." }
  });

  assert.equal(pending.status, "pending_approval");
  assert.equal(pending.scheduledAt, TUESDAY_TEN);
  assert.equal(pending.caption, "Légende revue à la soumission.");
  assert.equal(pending.approvalId, approval.id);
  assert.equal((await repository.listApprovals()).length, 1);

  // What the submission may carry stops at content: it cannot state a decision,
  // and it cannot take the identifier of the approval that was just reserved.
  const other = await createPublication(repository, draft());
  await preparePublication(repository, other.id);
  await assert.rejects(
    requestPublicationApproval(repository, other.id, {
      changes: { approvalDecision: "approved", approvalDecidedAt: NOW }
    }),
    { code: "PUBLICATION_DECISION_NOT_TRANSITIONABLE" }
  );
  assert.equal((await repository.listApprovals()).length, 1, "a refused submission creates no approval");

  const forced = await requestPublicationApproval(repository, other.id, { changes: { approvalId: "id-invente" } });
  assert.notEqual(forced.publication.approvalId, "id-invente");
  assert.equal(forced.publication.approvalId, forced.approval.id);
});

// The Prisma repository is exercised through a client that records the query it
// is given: the where clause is what the two repositories must agree on, and it
// can be read without a database.
function recordingPrisma() {
  const calls = [];
  const repository = new PrismaRepository({
    prisma: {
      socialPublication: {
        findMany: async (args) => {
          calls.push(args);
          return [];
        }
      }
    }
  });
  return { repository, calls };
}

test("an absent bound is absent in both repositories, as undefined or as null", async () => {
  const memory = new InMemoryRepository();
  const dated = await planned(memory, { scheduledAt: TUESDAY_TEN });
  const undatedPublication = await planned(memory);

  // No window at all: everything, dated or not, in both shapes.
  for (const filters of [{}, { from: undefined, to: undefined }, { from: null, to: null }]) {
    const rows = (await memory.listPublications(filters)).map((publication) => publication.id);
    assert.deepEqual(rows.sort(), [dated.id, undatedPublication.id].sort(), `memory: ${JSON.stringify(filters)}`);
  }

  // One bound only: null on the other side must not become a bound.
  assert.deepEqual(
    (await memory.listPublications({ from: null, to: "2026-10-09T23:59:59.999Z" })).map((row) => row.id),
    [dated.id],
    "a null lower bound lets an earlier publication through"
  );
  assert.deepEqual(
    (await memory.listPublications({ from: "2026-10-05T00:00:00.000Z", to: null })).map((row) => row.id),
    [dated.id]
  );

  const { repository, calls } = recordingPrisma();
  await repository.listPublications({});
  await repository.listPublications({ from: undefined, to: undefined });
  await repository.listPublications({ from: null, to: null });
  assert.deepEqual(
    calls.map((call) => call.where.scheduledAt),
    [undefined, undefined, undefined],
    "Prisma builds no window either, and never a 1970 bound"
  );

  await repository.listPublications({ from: null, to: "2026-10-09T23:59:59.999Z" });
  assert.deepEqual(calls.at(-1).where.scheduledAt, { lte: new Date("2026-10-09T23:59:59.999Z") });

  await repository.listPublications({ from: "2026-10-05T00:00:00.000Z", to: null });
  assert.deepEqual(calls.at(-1).where.scheduledAt, { gte: new Date("2026-10-05T00:00:00.000Z") });

  // And a real window is still a real window on both sides.
  await repository.listPublications({ from: "2026-10-05T00:00:00.000Z", to: "2026-10-09T23:59:59.999Z" });
  assert.deepEqual(calls.at(-1).where.scheduledAt, {
    gte: new Date("2026-10-05T00:00:00.000Z"),
    lte: new Date("2026-10-09T23:59:59.999Z")
  });
  assert.deepEqual(
    (await memory.listPublications({ from: "2026-10-05T00:00:00.000Z", to: "2026-10-09T23:59:59.999Z" })).map(
      (row) => row.id
    ),
    [dated.id],
    "and an undated publication is still outside a real window"
  );
});
