/**
 * Date/time utilities. All timestamps are stored as ISO-8601 UTC strings.
 * All *interpretation* happens in the user's configured timezone (default
 * Asia/Kolkata), never the server's local timezone.
 */

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  weekday: number; // 0=Sunday
}

export function zonedParts(ms: number, timezone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    weekday: "short",
  });
  const parts = fmt.formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
  const hour = get("hour") === 24 ? 0 : get("hour");
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    parts.find((p) => p.type === "weekday")?.value || ""
  );
  return { year: get("year"), month: get("month"), day: get("day"), hour, minute: get("minute"), weekday: wd };
}

/** Milliseconds at the given zoned date/time (in the given timezone). */
export function zonedMs(
  { year, month, day, hour = 0, minute = 0 }: { year: number; month: number; day: number; hour?: number; minute?: number },
  timezone: string
): number {
  // Absolute ms for a wall-clock time in `timezone`:
  //   abs = asUTC - offset,  offset = wallClockInTz(asUTC) - asUTC
  const asUTC = Date.UTC(year, month - 1, day, hour, minute);
  const parts = zonedParts(asUTC, timezone);
  const wallInTz = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return asUTC - (wallInTz - asUTC);
}

export function todayStart(now = Date.now(), timezone = "Asia/Kolkata"): number {
  const p = zonedParts(now, timezone);
  return zonedMs({ year: p.year, month: p.month, day: p.day }, timezone);
}

export function todayEnd(now = Date.now(), timezone = "Asia/Kolkata"): number {
  return todayStart(now, timezone) + DAY;
}

export function toISO(ms: number): string {
  return new Date(ms).toISOString();
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function addDays(ms: number, days: number): number {
  return ms + days * DAY;
}

export function addMinutes(ms: number, minutes: number): number {
  return ms + minutes * MINUTE;
}

/** True if two zoned days are the same calendar day. */
export function sameDay(a: number, b: number, timezone: string): boolean {
  const pa = zonedParts(a, timezone);
  const pb = zonedParts(b, timezone);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

export function formatZoned(ms: number, timezone: string, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone,
    ...opts,
  }).format(new Date(ms));
}

export function ymd(ms: number, timezone: string): string {
  const p = zonedParts(ms, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// ─── Natural-language date parsing ────────────────────────────────────────────

export const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, ravivaar: 0, ravivar: 0,
  monday: 1, mon: 1, somvaar: 1, somwar: 1, somvar: 1,
  tuesday: 2, tue: 2, tues: 2, mangalvaar: 2, mangalvar: 2,
  wednesday: 3, wed: 3, budhvaar: 3, budhvar: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, guruvaar: 4, guruvar: 4,
  friday: 5, fri: 5, shukravaar: 5, shukravar: 5,
  saturday: 6, sat: 6, shanivaar: 6, shanivar: 6,
};

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

export interface ParsedDateTime {
  /** Absolute due/reminder timestamp (ms) if a date/time was found. */
  at?: number;
  /** Which phrase(s) were consumed, e.g. ["tomorrow", "at 10"]. */
  matched: string[];
  /** Any remaining ambiguity, e.g. "kal" could be yesterday. */
  notes?: string;
}

const TIME_RE =
  /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)?\b/g;

const TIME_WORDS: Record<string, { h: number; m: number }> = {
  morning: { h: 9, m: 0 },
  "in the morning": { h: 9, m: 0 },
  afternoon: { h: 14, m: 0 },
  "in the afternoon": { h: 14, m: 0 },
  evening: { h: 18, m: 0 },
  "in the evening": { h: 18, m: 0 },
  tonight: { h: 21, m: 0 },
  midnight: { h: 0, m: 0 },
  noon: { h: 12, m: 0 },
  midday: { h: 12, m: 0 },
};

function nextWeekday(from: ZonedParts, target: number, allowToday: boolean): number {
  const daysAhead = (target - from.weekday + 7) % 7;
  if (daysAhead === 0 && !allowToday) return 7;
  return daysAhead;
}

function zonedDayAt(nowMs: number, timezone: string, dayOffset: number): ZonedParts {
  const start = todayStart(nowMs, timezone) + dayOffset * DAY;
  return zonedParts(start, timezone);
}

/**
 * Parse a full natural-language date/time phrase. Returns the absolute ms
 * timestamp in the given timezone.
 */
export function parseDatePhrase(text: string, now = Date.now(), timezone = "Asia/Kolkata"): ParsedDateTime {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  let baseDayOffset = 0; // in days from today
  let baseDate: ZonedParts | null = null;
  let time: { h: number; m: number } | null = null;
  let explicitTime = false;
  let relativeMs: number | null = null;

  // Relative day words (Hinglish + English)
  const relDay = (re: RegExp, offset: number, label: string) => {
    if (re.test(lower)) {
      baseDayOffset = offset;
      matched.push(label);
      return true;
    }
    return false;
  };
  if (relDay(/\b(day after tomorrow|parson|parso)\b/, 2, "day after tomorrow")) {
  } else if (relDay(/\b(day before yesterday|narson|narso)\b/, -2, "day before yesterday")) {
  } else if (relDay(/\b(tomorrow|tom|kal|aane wale kal|aane wala kal)\b/, 1, "tomorrow")) {
  } else if (relDay(/\b(yesterday|kall)\b/, -1, "yesterday")) {
  } else if (relDay(/\b(today|aaj|aaj hi)\b/, 0, "today")) {
  }

  // "in N days/weeks/hours/minutes" (word or digit numbers) & Hinglish
  const WORD_NUMS: Record<string, number> = {
    "half an": 0.5, half: 0.5, an: 1, a: 1,
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  };
  const wordNumPattern = Object.keys(WORD_NUMS).join("|");
  const relUnitPattern = "day|days|week|weeks|hour|hours|minute|minutes|month|months|hafte|hafteen|din|dino|ghante|ghanta|mahine|mahina";
  const inRel =
    new RegExp(`\\b(?:in|within)\\s+(?:(${wordNumPattern}|\\d+)\\s+)?(${relUnitPattern})\\b`, "i").exec(lower) ||
    new RegExp(`\\b(\\d+|${wordNumPattern})\\s+(${relUnitPattern})\\s+(?:mein|me|baad|ke baad|bad)\\b`, "i").exec(lower);
  if (inRel) {
    const nStr = (inRel[1] || "").toLowerCase();
    const unit = inRel[2]!.toLowerCase();
    let n = 1;
    if (nStr) n = WORD_NUMS[nStr] ?? (Number(nStr) || 1);
    const mult: Record<string, number> = {
      day: 1, days: 1, din: 1, dino: 1,
      week: 7, weeks: 7, hafte: 7, hafteen: 7,
      hour: 1 / 24, hours: 1 / 24, ghanta: 1 / 24, ghante: 1 / 24,
      minute: 1 / 1440, minutes: 1 / 1440,
      month: 30, months: 30, mahina: 30, mahine: 30,
    };
    const factor = mult[unit] ?? 1;
    relativeMs = now + n * factor * DAY;
    matched.push(inRel[0]);
    if (unit.startsWith("hour") || unit.startsWith("ghanta") || unit === "minute" || unit === "minutes") {
      explicitTime = true;
    }
  }

  // "next Monday" / "this Friday" / bare weekday / "Friday ko"
  const WEEKDAY_ALT =
    "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)" +
    "|(?:somvaar|somwar|somvar|mangalvaar|mangalvar|budhvaar|budhvar|guruvaar|guruvar|shukravaar|shukravar|shanivaar|shanivar|ravivaar|ravivar)";
  const weekdayRe =
    new RegExp(`\\b(?:next|coming|this|upcoming|agle|agla)\\s+(${WEEKDAY_ALT})\\b`, "i").exec(lower) ||
    new RegExp(`\\b(${WEEKDAY_ALT})(?:\\s+ko)?\\b`, "i").exec(lower);
  if (weekdayRe) {
    const name = weekdayRe[1]!.toLowerCase();
    const wd = WEEKDAYS[name]!;
    const from = zonedParts(now, timezone);
    // "this/coming" weekdays include today; bare weekdays default to the
    // next occurrence (so "Monday" said on Monday means next Monday)
    const allowToday = /\b(this|coming|agle|agla)\b/.test(lower);
    const offset = nextWeekday(from, wd, allowToday);
    baseDayOffset = offset;
    matched.push(weekdayRe[0].trim());
  }

  // "next week" / "coming week" / "agle hafte"
  if (/\b(?:next|coming|agle|agla)\s+(week|hafte|hafta)\b/.test(lower)) {
    baseDayOffset = 7;
    matched.push("next week");
  }

  // Absolute dates: "March 5", "5 March", "5/3"
  const absDateRe =
    /\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.exec(lower) ||
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(lower);
  if (absDateRe) {
    const isDayFirst = /\d/.test(absDateRe[1] || "");
    const day = isDayFirst ? Number(absDateRe[1]) : Number(absDateRe[2]);
    const monthName = (isDayFirst ? absDateRe[2] : absDateRe[1])!.toLowerCase();
    const month = MONTHS[monthName]!;
    const from = zonedParts(now, timezone);
    let year = from.year;
    const candidate = zonedMs({ year, month, day }, timezone);
    if (candidate < todayStart(now, timezone) - DAY) year += 1;
    baseDate = zonedParts(zonedMs({ year, month, day }, timezone), timezone);
    matched.push(absDateRe[0]);
  }
  const slashDateRe = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/.exec(lower);
  if (slashDateRe && !baseDate) {
    const a = Number(slashDateRe[1]);
    const b = Number(slashDateRe[2]);
    if (a >= 1 && a <= 31 && b >= 1 && b <= 12) {
      const from = zonedParts(now, timezone);
      let year = slashDateRe[3] ? Number(slashDateRe[3]) : from.year;
      if (year < 100) year += 2000;
      baseDate = zonedParts(zonedMs({ year, month: b, day: a }, timezone), timezone);
      if (zonedMs(baseDate, timezone) < todayStart(now, timezone) - DAY) {
        baseDate = zonedParts(zonedMs({ year: year + 1, month: b, day: a }, timezone), timezone);
      }
      matched.push(slashDateRe[0]);
    }
  }

  // Time words
  for (const [word, t] of Object.entries(TIME_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(lower)) {
      time = t;
      explicitTime = true;
      matched.push(word);
      break;
    }
  }

  // Word-number times: "twelve thirty", "half past ten", "ten o'clock"
  const WORD_HOURS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  };
  const WORD_TIME_RE =
    /\b(?:half past\s+)?(twelve|one|two|three|four|five|six|seven|eight|nine|ten|eleven)\s*(thirty|fifteen|forty[- ]?five|o'?clock|baje)?\b/i.exec(lower);
  if (WORD_TIME_RE) {
    const h = WORD_HOURS[WORD_TIME_RE[1]!.toLowerCase()]!;
    const mins: Record<string, number> = { thirty: 30, fifteen: 15, "forty-five": 45, "forty five": 45, "fortyfive": 45 };
    const min = WORD_TIME_RE[2] ? (mins[WORD_TIME_RE[2].toLowerCase()] ?? 0) : 0;
    time = { h, m: min };
    explicitTime = true;
    matched.push(WORD_TIME_RE[0]);
  }

  // "at 10", "by 5pm", "10 baje", "12:30", "at 12:30"
  // Re-scan with a context-aware approach: find "NN:MM" or hour with marker
  const colonRe = /\b(\d{1,2}):(\d{2})(?!\d)/.exec(lower);
  if (colonRe) {
    let h = Number(colonRe[1]);
    const m = Number(colonRe[2]);
    if (h < 12 && /\bpm\b/.test(lower)) h += 12;
    time = { h, m };
    explicitTime = true;
    matched.push(colonRe[0]);
  } else {
    const hhRe = /\b(?:at|by|around|ko|baje|tak|o'?clock)?\s*(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.|baje|o'?clock)?\b/i.exec(lower);
    // Only accept a bare number as time when preceded by at/by/ko/baje/tak or followed by am/pm/baje
    const markerRe = /\b(at|by|around|ko|baje|tak)\s+(\d{1,2})\b/i.exec(lower);
    const suffixedRe = /\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)\b/i.exec(lower);
    if (suffixedRe) {
      const hStr = suffixedRe[1];
      const ampm = suffixedRe[2];
      let h = Number(hStr ?? 0);
      const m = 0;
      if (/pm/i.test(ampm || "") && h < 12) h += 12;
      if (/am/i.test(ampm || "") && h === 12) h = 0;
      time = { h, m };
      explicitTime = true;
      matched.push(suffixedRe[0]);
    } else if (markerRe) {
      const hStr = markerRe[2];
      let h = Number(hStr ?? 0);
      const m = 0;
      time = { h, m };
      explicitTime = true;
      matched.push(markerRe[0]);
    } else if (hhRe && /\b(am|pm|baje|o'?clock)\b/i.test(hhRe[0])) {
      // handled by suffixedRe mostly; fallback
      let h = Number(hhRe[1]);
      if (/pm/i.test(hhRe[0]) && h < 12) h += 12;
      time = { h, m: 0 };
      explicitTime = true;
      matched.push(hhRe[0]);
    }
  }

  // Combine
  if (relativeMs !== null) {
    return { at: Math.round(relativeMs), matched };
  }

  let dayStart: number;
  if (baseDate) {
    dayStart = zonedMs(baseDate, timezone);
  } else {
    const from = zonedParts(now, timezone);
    dayStart = todayStart(now, timezone) + baseDayOffset * DAY;
    // If the day is today/yesterday-derived and time already passed, keep date
    // (deadlines in the past still parse; caller decides overdue)
    void from;
  }

  let at = dayStart;
  if (time) {
    const p = zonedParts(dayStart, timezone);
    at = zonedMs({ year: p.year, month: p.month, day: p.day, hour: time.h, minute: time.m }, timezone);
  } else {
    // Default to end-of-day for deadlines ("by Wednesday") → 23:59
    at = dayStart + DAY - 1;
  }

  // A bare time that has already passed today → roll to tomorrow
  // ("at 9" said at 10:00 means tomorrow 9). Never roll when the user
  // explicitly said a past day.
  if (time && at < now && !matched.some((m) => /yesterday|day before|narson/.test(m))) {
    const p = zonedParts(dayStart + DAY, timezone);
    at = zonedMs({ year: p.year, month: p.month, day: p.day, hour: time.h, minute: time.m }, timezone);
    matched.push("(rolled to tomorrow)");
  }

  return { at: Math.round(at), matched };
}

/**
 * Extracts a reminder time from "remind me <when>" phrases, handling
 * offsets like "two hours before the lecture" (returns offset minutes).
 */
export interface ReminderParse {
  /** Absolute time when a plain reminder time is given. */
  at?: number;
  /** Offset in minutes before the related task's deadline. */
  offsetBeforeDeadline?: number;
  /** Recurrence descriptor like "weekly:friday". */
  recurrence?: string;
  matched: string[];
}

export function parseReminderPhrase(text: string, now = Date.now(), timezone = "Asia/Kolkata"): ReminderParse {
  const lower = text.toLowerCase();
  const matched: string[] = [];

  // Recurring: every Monday / every week / har somvaar / daily / every day
  const recRe =
    /\bevery\s+(?:(week|day|month)|((?:mon|tue|wed|thu|fri|sat|sun)(?:day)?|(?:somvaar|somwar|mangalvaar|mangalvar|budhvaar|budhvar|guruvaar|guruvar|shukravaar|shukravar|shanivaar|shanivar|ravivaar|ravivar)))\b/i.exec(lower) ||
    /\bhar\s+(?:(hafte|hafta|din|mahina)|((?:somvaar|somwar|mangalvaar|mangalvar|budhvaar|budhvar|guruvaar|guruvar|shukravaar|shukravar|shanivaar|shanivar|ravivaar|ravivar)))\b/i.exec(lower);
  if (recRe) {
    const unit = (recRe[1] || recRe[2] || "").toLowerCase();
    if (unit === "day") matched.push("every day");
    else if (unit === "week") matched.push("every week");
    else if (unit === "month") matched.push("every month");
    else {
      matched.push(`every ${unit}`);
    }
    let recurrence: string;
    if (unit === "day") recurrence = "daily";
    else if (unit === "week") recurrence = "weekly";
    else if (unit === "month") recurrence = "monthly";
    else recurrence = `weekly:${unit}`;
    // Look for a time as well
    const base = parseDatePhrase(text, now, timezone);
    const timeMatch = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(lower.replace(recRe[0], " "));
    if (timeMatch && /(am|pm)/i.test(timeMatch[0] || "") && base.at) {
      const p = zonedParts(base.at, timezone);
      let h = Number(timeMatch[1]);
      const m = Number(timeMatch[2] || 0);
      if (/pm/i.test(timeMatch[3] || "") && h < 12) h += 12;
      const at = zonedMs({ year: p.year, month: p.month, day: p.day, hour: h, minute: m }, timezone);
      matched.push(timeMatch[0]);
      return { at, recurrence, matched };
    }
    return { recurrence, matched };
  }

  // "N hours/days before the lecture/task/deadline"
  const offsetWords = "one|two|three|four|five|six|seven|eight|nine|ten|an?|half an?";
  const offsetRe =
    new RegExp(`\\b(\\d+|${offsetWords})\\s+(hour|hours|day|days|ghante|ghanta|din|dino)\\s+(before|pehle)\\b`, "i").exec(lower) ||
    new RegExp(`\\b(?:before|pehle)\\s+(?:the\\s+)?(\\d+|${offsetWords})\\s+(hour|hours|day|days|ghante|ghanta|din|dino)\\b`, "i").exec(lower);
  if (offsetRe) {
    const nStr = offsetRe[1]!.toLowerCase();
    const unit = offsetRe[2]!.toLowerCase();
    const wordMap: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    let n = nStr === "an" || nStr === "a" ? 1 : nStr === "half" ? 0.5 : wordMap[nStr] ?? Number(nStr);
    if (unit.startsWith("day") || unit.startsWith("din")) n *= 24 * 60;
    else if (unit.startsWith("hour") || unit.startsWith("ghanta")) n *= 60;
    matched.push(offsetRe[0]);
    return { offsetBeforeDeadline: Math.round(n), matched };
  }

  // Plain absolute time
  const parsed = parseDatePhrase(text, now, timezone);
  return { at: parsed.at, matched: parsed.matched };
}

/** Compute the actual timestamp for an offset-based reminder given a deadline. */
export function applyOffset(deadlineMs: number, offsetMinutes: number): number {
  return deadlineMs - offsetMinutes * MINUTE;
}