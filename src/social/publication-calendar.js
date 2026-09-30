import { PUBLICATION_CHANNELS } from "./publication.js";

// M2.2 editorial calendar. It is a read model over the publications M2.1 already
// stores, plus the one rule that belongs to planning: a new slot is in the
// future. Nothing here sends, schedules or publishes anything; no background
// worker, no connector, no network.
//
// Instants stay stored in UTC, exactly as M2.1 writes them. This module is the
// only place that reads them in business time, because a publication calendar is
// read in the hours people live in, not in UTC. Morocco sits at UTC+1 and drops
// to UTC+0 for Ramadan, so the offset is asked of the runtime for each instant
// rather than assumed once.
export const PUBLICATION_CALENDAR_TIME_ZONE = "Africa/Casablanca";

// A cancelled or refused publication is not editorial planning any more. It
// stays in storage; it just does not occupy a slot.
export const CALENDAR_EXCLUDED_STATUSES = Object.freeze(["cancelled", "rejected"]);

export class PublicationCalendarError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "PublicationCalendarError";
    this.code = code;
    this.details = details;
  }
}

// Reads the calendar over a window. The window is resolved first, so a bad one
// is refused before the repository is touched.
export async function readPublicationCalendar(repository, options = {}) {
  const window = resolveCalendarWindow(options);
  const publications = await repository.listPublications({
    from: window.from,
    to: window.to,
    channel: options.channel
  });

  return buildPublicationCalendar(publications, { ...options, ...window });
}

// Pure builder: it takes publications and gives back the calendar. A past window
// is read exactly like a future one — reading history is not planning.
export function buildPublicationCalendar(publications = [], options = {}) {
  const window = resolveCalendarWindow(options);
  const channel = resolveChannelFilter(options.channel);
  const timeZone = options.timeZone ?? PUBLICATION_CALENDAR_TIME_ZONE;
  const fromMs = Date.parse(window.from);
  const toMs = Date.parse(window.to);

  const entries = [];
  for (const publication of publications) {
    if (!publication?.scheduledAt || CALENDAR_EXCLUDED_STATUSES.includes(publication.status)) {
      continue;
    }
    if (channel !== null && publication.channel !== channel) {
      continue;
    }

    const at = instantOf(publication.scheduledAt, "scheduledAt");
    const atMs = at.getTime();
    if (atMs < fromMs || atMs > toMs) {
      continue;
    }

    const local = localPartsOf(at, timeZone);
    entries.push({
      publicationId: publication.id,
      channel: publication.channel,
      status: publication.status,
      caption: publication.caption ?? "",
      scheduledAt: at.toISOString(),
      localDate: local.date,
      localTime: local.time,
      localDay: local.weekday,
      slot: `${local.date}T${local.time}`,
      conflict: false
    });
  }

  // One order, always the same: by instant, then by identifier so two
  // publications sharing a slot never swap places between two reads.
  entries.sort((left, right) => {
    const byInstant = Date.parse(left.scheduledAt) - Date.parse(right.scheduledAt);
    return byInstant !== 0 ? byInstant : left.publicationId.localeCompare(right.publicationId);
  });

  const slots = groupIntoSlots(entries);
  const conflicts = [];
  for (const slot of slots) {
    if (slot.entries.length < 2) {
      continue;
    }
    // Two posts on one channel at one time are reported, never refused: a
    // reschedule can legitimately produce them, and the calendar is not the
    // place that decides.
    for (const entry of slot.entries) {
      entry.conflict = true;
    }
    conflicts.push(
      Object.freeze({
        channel: slot.channel,
        slot: slot.slot,
        scheduledAt: slot.scheduledAt,
        publicationIds: Object.freeze(slot.entries.map((entry) => entry.publicationId))
      })
    );
  }

  return Object.freeze({
    timeZone,
    window: Object.freeze({ ...window }),
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
    slots: Object.freeze(slots.map((slot) => Object.freeze({ ...slot, entries: Object.freeze(slot.entries) }))),
    conflicts: Object.freeze(conflicts)
  });
}

// A window is two instants. Given a bare day it covers that whole day in
// business time, which is how a week is asked for out loud.
export function resolveCalendarWindow({ from, to, timeZone = PUBLICATION_CALENDAR_TIME_ZONE } = {}) {
  const start = boundaryOf(from, "from", "start", timeZone);
  const end = boundaryOf(to, "to", "end", timeZone);

  if (start.getTime() > end.getTime()) {
    throw new PublicationCalendarError("The calendar window ends before it starts.", "PUBLICATION_CALENDAR_WINDOW_INVALID", {
      from: start.toISOString(),
      to: end.toISOString()
    });
  }

  return { from: start.toISOString(), to: end.toISOString() };
}

// The one planning rule in this module: a new slot cannot be in the past.
// Reading a past window is a different operation and stays open.
export function assertFuturePublicationSlot(scheduledAt, { now = new Date().toISOString() } = {}) {
  const at = instantOf(scheduledAt, "scheduledAt");
  const reference = instantOf(now, "now");

  if (at.getTime() < reference.getTime()) {
    throw new PublicationCalendarError(
      "A new publication cannot be planned in the past.",
      "PUBLICATION_SCHEDULE_IN_PAST",
      {
        scheduledAt: at.toISOString(),
        now: reference.toISOString(),
        localSlot: localSlotOf(at)
      }
    );
  }

  return at.toISOString();
}

// The slot a publication occupies, in business time.
export function localSlotOf(scheduledAt, timeZone = PUBLICATION_CALENDAR_TIME_ZONE) {
  const local = localPartsOf(instantOf(scheduledAt, "scheduledAt"), timeZone);
  return `${local.date}T${local.time}`;
}

function groupIntoSlots(entries) {
  const byKey = new Map();

  for (const entry of entries) {
    const key = `${entry.channel}|${entry.slot}`;
    const slot = byKey.get(key);
    if (slot) {
      slot.entries.push(entry);
      continue;
    }
    byKey.set(key, {
      channel: entry.channel,
      slot: entry.slot,
      scheduledAt: entry.scheduledAt,
      entries: [entry]
    });
  }

  // Entries are already ordered, and a Map keeps insertion order, so the slots
  // come out chronologically without a second sort.
  return [...byKey.values()];
}

function resolveChannelFilter(channel) {
  if (channel === undefined || channel === null) {
    return null;
  }
  if (!PUBLICATION_CHANNELS.includes(channel)) {
    throw new PublicationCalendarError(`Unknown publication channel: ${channel}`, "PUBLICATION_CALENDAR_CHANNEL_UNKNOWN", {
      channel,
      channels: [...PUBLICATION_CHANNELS]
    });
  }
  return channel;
}

function boundaryOf(value, field, edge, timeZone) {
  if (value === null || value === undefined || value === "") {
    throw new PublicationCalendarError(`${field} is required to read the calendar.`, "PUBLICATION_CALENDAR_WINDOW_INVALID", {
      field
    });
  }

  // A bare day is business time: "2026-10-05" is that day in Casablanca, from
  // its first minute to its last, not a UTC day shifted by an hour.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return edge === "start"
      ? instantFromLocalParts({ year, month, day, hour: 0, minute: 0, second: 0, ms: 0 }, timeZone)
      : instantFromLocalParts({ year, month, day, hour: 23, minute: 59, second: 59, ms: 999 }, timeZone);
  }

  return instantOf(value, field);
}

function instantOf(value, field) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new PublicationCalendarError(`${field} is not a usable date.`, "PUBLICATION_CALENDAR_DATE_INVALID", { field });
    }
    return value;
  }

  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new PublicationCalendarError(`${field} must be an ISO date and time.`, "PUBLICATION_CALENDAR_DATE_INVALID", {
      field,
      value: typeof value === "string" ? value : typeof value
    });
  }

  return new Date(value);
}

const localFormatters = new Map();

function localFormatter(timeZone) {
  const cached = localFormatters.get(timeZone);
  if (cached) {
    return cached;
  }

  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  } catch (cause) {
    throw new PublicationCalendarError(`Unknown time zone: ${timeZone}`, "PUBLICATION_CALENDAR_TIME_ZONE_UNKNOWN", {
      timeZone,
      cause: cause.message
    });
  }

  localFormatters.set(timeZone, formatter);
  return formatter;
}

function localPartsOf(instant, timeZone = PUBLICATION_CALENDAR_TIME_ZONE) {
  const parts = {};
  for (const part of localFormatter(timeZone).formatToParts(instant)) {
    parts[part.type] = part.value;
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  };
}

// How far business time runs ahead of UTC at that instant. Asked of the runtime
// each time, because Morocco changes it for Ramadan.
function offsetAt(instantMs, timeZone) {
  const local = localPartsOf(new Date(instantMs), timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

// A wall clock reading in business time back to the instant it names. The offset
// is taken twice: the first guess can land on the wrong side of a Ramadan
// transition, and the second reading is the one that actually holds.
function instantFromLocalParts({ year, month, day, hour, minute, second, ms }, timeZone) {
  const wallClock = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const firstGuess = wallClock - offsetAt(wallClock, timeZone);
  const settled = wallClock - offsetAt(firstGuess, timeZone);
  return new Date(settled);
}
