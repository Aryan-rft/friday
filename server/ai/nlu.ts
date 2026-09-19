/**
 * Deterministic NLU — the always-available interpretation layer.
 * Detects intent and extracts structured fields from natural English and
 * Hinglish voice/text input. When an LLM is configured, `interpret.ts`
 * prefers the LLM and falls back to this engine.
 */

import { parseDatePhrase, parseReminderPhrase, applyOffset, zonedParts, todayStart, DAY, HOUR, addDays, MINUTE } from "../lib/dates.js";
import { classifyProject } from "../lib/projects.js";
import { computePriority, type Priority } from "../lib/priority.js";

export type IntentType =
  | "create_task"
  | "remind"
  | "follow_up"
  | "complete"
  | "reschedule"
  | "delete"
  | "set_priority"
  | "query_today"
  | "query_urgent"
  | "query_overdue"
  | "query_waiting"
  | "query_project"
  | "query_upcoming"
  | "query_finished"
  | "query_unfinished"
  | "query_focus"
  | "briefing"
  | "evening_review"
  | "weekly_summary"
  | "remember"
  | "create_goal"
  | "query_goals"
  | "give_feedback"
  | "smalltalk"
  | "help";

export interface TaskDraft {
  title: string;
  description?: string;
  projectSlug?: string;
  priority?: Priority;
  deadlineAt?: string;
  dueDate?: string;
  dueTime?: string;
  taskType?: string;
  recurrence?: string;
  people?: string[];
  isFollowUp?: boolean;
  followUp?: { entity: string; reason: string; at?: string };
  reminder?: { title?: string; at?: string; offsetBeforeDeadline?: number; recurrence?: string };
}

export interface QuerySpec {
  projectSlug?: string;
  period?: "today" | "week" | "month";
}

export interface Analysis {
  intent: IntentType;
  task?: TaskDraft;
  targetTitle?: string;
  newDeadlineAt?: string;
  newPriority?: Priority;
  query?: QuerySpec;
  rememberText?: string;
  goal?: { title: string; horizon?: string; description?: string };
  feedback?: { category: string; comment: string };
  reply?: string;
  matched: string[];
}

export interface AnalyzeContext {
  now?: number;
  timezone?: string;
  knownProjectSlugs?: string[];
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

const FILLER_PREFIXES = [
  "i need to ", "i have to ", "i want to ", "i gotta ", "i must ",
  "i should ", "i will ", "i'll ", "i am going to ", "i'm going to ",
  "i am planning to ", "i plan to ", "please ", "can you ", "could you ",
  "would you ", "do me a favour and ", "make sure to ", "make sure i ",
  "remember to ", "don't forget to ", "dont forget to ", "add a task to ",
  "add a task ", "add task ", "create a task ", "create task ",
  "create a to-do ", "create todo ", "add to my list ", "schedule ",
  "plan to ", "remind me to ", "remind me ", "set a reminder to ",
  "set reminder to ", "notify me to ", "note that ", "karna hai ",
  "karna hai.", "karni hai ", "karna hoga ", "karni hain ", "karne hain ",
  "karna hai, ", "karne ka hai ", "karne hain.", "karni hai.",
  "karna hai.", "chahiye ", "add ", "create ", "need to ", "need ",
];

const HINGLISH_REMOVALS: [RegExp, string][] = [
  [/\b(ke liye|ke liye,)\b/g, " for "],
  [/\b(mein|me|ma|se)\b/g, " "], // "mein" = in, "se" = from
  [/\b(ko|ki|ka|ke)\b/g, " "],
  [/\b(karna|karni|karne|karein|karenge|karunga|karungi|karo)\b/g, " "],
  [/\b(hai|hain|hoga|hogee|hogi|tha|thi|raha|rahi|rahe)\b/g, " "],
  [/\b(wali|wala|wale)\b/g, " "],
  [/\b(aur|or)\b/g, " "],
];

const DATE_PHRASE_REMOVAL = [
  /\b(day after tomorrow|parson|parso)\b/gi,
  /\b(day before yesterday|narson|narso)\b/gi,
  /\b(tomorrow|tom|kal|aane wale kal|aane wala kal)\b/gi,
  /\b(yesterday|kall)\b/gi,
  /\b(today|aaj)\b/gi,
  /\b(next|coming|this|upcoming|agle|agla)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|somvaar|somwar|mangalvaar|mangalvar|budhvaar|budhvar|guruvaar|guruvar|shukravaar|shukravar|shanivaar|shanivar|ravivaar|ravivar)\b/gi,
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|somvaar|somwar|mangalvaar|mangalvar|budhvaar|budhvar|guruvaar|guruvar|shukravaar|shukravar|shanivaar|shanivar|ravivaar|ravivar)\s+ko\b/gi,
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|somvaar|somwar|mangalvaar|mangalvar|budhvaar|budhvar|guruvaar|guruvar|shukravaar|shukravar|shanivaar|shanivar|ravivaar|ravivar)\b/gi,
  /\b(in|within|after|baad)\s+(an?\s+|half an?\s+|(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+)?(day|days|week|weeks|hour|hours|minute|minutes|month|months|hafte|hafteen|din|dino|ghante|ghanta|mahine|mahina)\b/gi,
  /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(din|dino|hafte|hafteen|ghante|ghanta|mahine|mahina)\s+(mein|me|baad|ke baad)\b/gi,
  /\b(at|by|around|ko|baje|tak)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|baje)?\b/gi,
  /\b(\d{1,2}):(\d{2})\b/gi,
  /\b(\d{1,2})\s*(am|pm|a\.m\.|p\.m\.)\b/gi,
  /\b(tonight|midnight|noon|midday|morning|afternoon|evening)\b/gi,
  /\b(by|before|until|till|tak|se pehle)\b/gi,
  /\b(twelve|one|two|three|four|five|six|seven|eight|nine|ten|eleven)\s*(thirty|fifteen|forty|forty-five|o'clock|baje)\b/gi,
  /\b(o'?clock)\b/gi,
];

function stripFiller(text: string): string {
  let t = text.trim();
  let changed = true;
  while (changed && t) {
    changed = false;
    const lower = " " + t.toLowerCase() + " ";
    for (const f of FILLER_PREFIXES) {
      const idx = lower.indexOf(" " + f);
      if (idx === 0) {
        t = t.slice(f.length).trim();
        changed = true;
        break;
      }
    }
    if (/^(please|hey|hi|ok|okay|so|well)[,\s]+/i.test(t)) {
      t = t.replace(/^(please|hey|hi|ok|okay|so|well)[,\s]+/i, "").trim();
      changed = true;
    }
  }
  return t;
}

function stripDatePhrases(text: string): string {
  let t = text;
  for (const re of DATE_PHRASE_REMOVAL) t = t.replace(re, " ");
  return t;
}

function stripHinglish(text: string): string {
  let t = " " + text + " ";
  for (const [re, rep] of HINGLISH_REMOVALS) t = t.replace(re, rep);
  return t.replace(/\s+/g, " ").trim();
}

function cleanTitle(text: string, timezone: string, now: number): string {
  let t = stripFiller(text);
  t = stripDatePhrases(t);
  t = stripHinglish(t);
  // fillers can become leading once date phrases are removed
  t = stripFiller(t);
  // "to call the outreach team" → "call the outreach team"
  t = t.replace(/^to\s+(?=[a-z])/i, "");
  // remove leftover punctuation and collapse
  t = t
    .replace(/^[:"'-\s]+/, "")
    .replace(/[.,;!?"'\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) {
    // fall back: original minus leading filler, dates only
    t = stripDatePhrases(stripFiller(text)).replace(/\s+/g, " ").trim();
  }
  if (!t) return "";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ─── Intent detection ─────────────────────────────────────────────────────────

export function detectIntent(text: string): { intent: IntentType; matched: string[] } {
  const lower = text.toLowerCase().trim();

  const has = (...patterns: RegExp[]) => patterns.some((p) => p.test(lower));

  if (has(/\b(hello|hi|hey|namaste|namaskar|good morning|good afternoon|good evening)\b/) && text.length < 40) {
    return { intent: "smalltalk", matched: ["greeting"] };
  }
  if (has(/\b(who are you|what can you do|help me|how do i use|what are you)\b/) || /\bhelp\b/.test(lower)) {
    return { intent: "help", matched: ["help"] };
  }
  if (has(/\b(thank|thanks|shukriya|dhanyawad)\b/) && text.length < 40) {
    return { intent: "smalltalk", matched: ["thanks"] };
  }

  // Briefings & summaries
  if (has(
    /\b(morning briefing|daily briefing|brief me|briefing|good morning)\b/,
    /\bsummar(?:y|ize|ise)\s+(my\s+)?day\b/,
    /\bwhat(?:'s| is) my day (?:look|looking) like\b/,
    /\b(brief|summary) (of|for) (today|my day)\b/
  )) {
    return { intent: "briefing", matched: ["briefing"] };
  }
  if (has(/\bevening (review|summary)\b/, /\b(end of day|end-of-day) (review|summary)\b/, /\bwrap up (my )?day\b/, /\bday recap\b/)) {
    return { intent: "evening_review", matched: ["evening review"] };
  }
  if (has(/\bweekly summary\b/, /\bweek(?:ly)? recap\b/, /\bthis week\b.*\bsummary\b/, /\bsummarize (my )?week\b/)) {
    return { intent: "weekly_summary", matched: ["weekly summary"] };
  }

  // Feedback about Friday's behaviour (must come before reminders/mutations)
  if (has(
    /\b(too early|too soon|pehle ho gaya|pehle aa gaya)\b/,
    /\b(too late|der ho gayi|der se)\b/,
    /\b(don'?t|do not|stop) (suggesting|suggest|reminding me about|nagging|recommending)\b/,
    /\bnot important (anymore|now|to me)\b/,
    /\b(make (it|them|this|that)(\s+\w+)? smaller|break (it|this|them|that)(\s+\w+)? (down|into smaller))\b/,
    /\bi prefer (doing|working|studying|to do)\b/,
    /\b(reminders? (are|is) (always )?(too|very) (early|late))\b/
  )) {
    return { intent: "give_feedback", matched: ["feedback"] };
  }

  // Goals
  if (has(
    /\b(add|create|set|new|track|start|note)\b.*\bgoals?\b/,
    /\bgoals? (is|:|for this)\b/,
    /\bmy (goal|mission) is\b/,
    /\bi want to\b.*\b(this (week|month|quarter|year)|by (next )?(year|decade))\b/
  )) {
    return { intent: "create_goal", matched: ["goal"] };
  }
  if (has(
    /\b(what|show|list|how)( are|'s| is)? my goals?\b/,
    /\bmy goals?\b/,
    /\bshow goals\b/,
    /\bhow (are|'re) (my|the) goals?\b/
  )) {
    return { intent: "query_goals", matched: ["goals query"] };
  }

  // Reminders
  if (has(/\bremind me\b/, /\breminder\b/, /\byaad dilana\b/, /\byaad dilao\b/, /\bnotify me\b/, /\balert me\b/, /\bset a reminder\b/, /\bset reminder\b/, /\bset an alarm\b/)) {
    return { intent: "remind", matched: ["remind"] };
  }

  // Follow-ups
  if (has(/\bfollow\s*-?\s*up\b/, /\bfollow up with\b/, /\bfollowup\b/, /\bfollow them up\b/, /\bchase (them|up)\b/, /\bcheck back\b/, /\bget back to (them|him|her)\b/, /\bnudge\b/, /\bping (them|him|her)\b/, /\bif they don'?t respond\b/, /\bif (he|she) doesn'?t respond\b/)) {
    return { intent: "follow_up", matched: ["follow up"] };
  }

  // Task mutations — conservative so "finish this tonight" stays a create-task
  const strongComplete = has(
    /\bmark\b.*\b(complete|done|completed|finished|khatam|ho gaya|ho gya)\b/,
    /\bdone with\b/,
    /\bcheck off\b/,
    /\btick off\b/,
    /\b(complete|done) karo\b/,
    /\bho gaya\b/,
    /\bho gya\b/,
    /\bwrap up\b/
  );
  const verbComplete = /\b(complete|finish(?:ed)?)\s+(the|this|that|my)\s+(?!(?:week|weekend|today|tonight|tomorrow|month)\b)[a-z]/.test(lower);
  const hasByDeadline = has(/\b(by|before|until|tak|se pehle)\b/);
  if (strongComplete || (verbComplete && !hasByDeadline)) {
    return { intent: "complete", matched: ["complete"] };
  }
  if (has(/\b(move|shift|push|reschedule|postpone|delay|advance|aage badhao|aage badha do|reschedule karo)\b.*\b(to|ko|tak|by)\b/)) {
    return { intent: "reschedule", matched: ["reschedule"] };
  }
  if (has(/\b(delete|remove|cancel|trash)\b.*\b(task|item|this|it|the)\b/, /\bdelete karo\b/, /\bremove karo\b/, /\bhata do\b/)) {
    return { intent: "delete", matched: ["delete"] };
  }
  if (has(/\b(make|set|change|mark)\b.*\b(urgent|high priority|critical|low priority|medium priority)\b/, /\b(urgent|high priority|critical|low priority)\s+(kar do|karo|banao)\b/)) {
    return { intent: "set_priority", matched: ["set priority"] };
  }

  // Queries
  if (has(/\bwhat do i have (today|tomorrow)\b/, /\bwhat'?s (on|for) today\b/, /\bwhat is (on|for) today\b/, /\btoday'?s (tasks|plan|schedule|agenda|list)\b/, /\baaj kya\b/, /\baaj ka\b/, /\bwhat do i need to do (today|now)\b/, /\bshow (me )?(today|todays)\b/, /\bmy (tasks|schedule|plan) (for )?today\b/, /\bwhat'?s my day\b/, /\b(what|anything) (is )?due today\b/)) {
    return { intent: "query_today", matched: ["today"] };
  }
  if (has(/\bwhat (is|are) (the )?(urgent|critical|high priority)\b/, /\bwhat'?s urgent\b/, /\bshow (me )?urgent\b/, /\burgent tasks\b/, /\bhigh priority tasks\b/, /\bwhat should i (do|prioritize) (first|right now)\b/)) {
    return { intent: "query_urgent", matched: ["urgent"] };
  }
  if (has(/\boverdue\b/, /\blate (tasks|items)\b/, /\bmissed (deadline|deadlines)\b/, /\bexpired\b/)) {
    return { intent: "query_overdue", matched: ["overdue"] };
  }
  if (has(/\bwaiting (for|on)\b/, /\bwaiting on\b/, /\bwhat am i waiting\b/, /\bwho am i waiting\b/, /\bfollow-?ups? (pending|due|coming)\b/, /\bwhat follow-?ups\b/, /\bkiska intezaar\b/, /\b(any|all) pending responses\b/, /\bwhat'?s pending\b/, /\boutstanding follow-?ups?\b/)) {
    return { intent: "query_waiting", matched: ["waiting"] };
  }
  if (has(/\bupcoming\b/, /\bdeadlines? (coming|coming up|upcoming)\b/, /\bwhat'?s (next|coming up)\b/, /\bwhat is (next|coming up)\b/, /\bcoming (week|days)\b/, /\bnext few (days|weeks)\b/, /\bwhat deadlines\b/, /\bagle hafte\b/)) {
    return { intent: "query_upcoming", matched: ["upcoming"] };
  }
  if (has(/\b(finish|finished|completed|complete|done|accomplish(?:ed)?|achieve(?:d)?)\b.*\b(this week|last week|this month|today|this week|this month|week)\b/, /\bwhat did i (finish|complete|accomplish|get done)\b/, /\brecently (finish|complete|done)\b/)) {
    return { intent: "query_finished", matched: ["finished"] };
  }
  if (has(/\b(unfinished|incomplete|not done|remaining|left(?: over)?|baki|pending) (tasks|work|items)\b/, /\bwhat'?s (unfinished|incomplete|left)\b/, /\bshow (me )?(unfinished|incomplete|remaining|baki)\b/, /\bwhat is (unfinished|incomplete|left|remaining)\b/, /\bpending tasks\b/)) {
    return { intent: "query_unfinished", matched: ["unfinished"] };
  }
  if (has(/\bwhat should i focus\b/, /\bfocus (on|first)\b/, /\bwhat'?s (the )?priority\b/, /\bwhat is (the )?priority\b/, /\bmost important\b.*\b(now|first|today)\b/)) {
    return { intent: "query_focus", matched: ["focus"] };
  }
  // Project queries: "KUK tasks", "tasks related to KUK", "everything related to KUK"
  if (has(/\b(tasks|work|items|things|anything|everything|what'?s|what is)\b.*\b(related to|for|about|with)\b/, /\b(show|list|display|give)\b.*\b(tasks|items|work|everything)\b/)) {
    return { intent: "query_project", matched: ["project query"] };
  }

  // Remember
  if (has(/\bremember (that|this|one thing|something)\b/, /\bkeep in mind\b/, /\byaad rakho\b/, /\byaad rakho ki\b/, /\bnote (this|that|down)\b/)) {
    return { intent: "remember", matched: ["remember"] };
  }

  return { intent: "create_task", matched: [] };
}

// ─── Number-word times ("twelve thirty") ───────────────────────────────────────

function parseWordTime(text: string): { h: number; m: number; phrase: string } | null {
  const re = /\b(twelve|one|two|three|four|five|six|seven|eight|nine|ten|eleven)\s*(thirty|fifteen|forty|forty[- ]five|o'?clock|baje)\b/i;
  const m = re.exec(text);
  if (!m) return null;
  const h = NUMBER_WORDS[m[1]!.toLowerCase()]!;
  const mins: Record<string, number> = { thirty: 30, fifteen: 15, forty: 40, "forty-five": 45, "forty five": 45 };
  const min = mins[m[2]!.toLowerCase()] ?? 0;
  return { h, m: min, phrase: m[0] };
}

// ─── People extraction ─────────────────────────────────────────────────────────

const PERSON_RE =
  /\b(?:with|from|to|ko|se|for)\s+([A-Z][a-zA-Z]+(?:\s+(?:ma'?am|sir|ji|madam|boss|uncle|aunty|bhaiya|didi|dr\.?|prof\.?))?)/g;
const PERSON_BEFORE_RE = /\b([A-Z][a-zA-Z]+(?:\s+(?:ma'?am|sir|ji|madam|boss))?)\s+(?:se|ko|ne)\b/g;

function extractPeople(text: string): string[] {
  const people: string[] = [];
  const add = (name: string) => {
    const clean = name.replace(/^(with|from|to|ko|se|for)\s+/i, "").trim();
    if (clean && !people.includes(clean) && clean.length > 1 && !/^(the|my|our|this|that|them|him|her|their|final|year|next|last)$/i.test(clean)) {
      people.push(clean);
    }
  };
  let m: RegExpExecArray | null;
  const re = new RegExp(PERSON_RE.source, "g");
  while ((m = re.exec(text)) !== null) add(m[1]!);
  const re2 = new RegExp(PERSON_BEFORE_RE.source, "g");
  while ((m = re2.exec(text)) !== null) add(m[1]!);
  return people;
}

// ─── Target extraction (for mutations) ─────────────────────────────────────────

function extractTarget(text: string, kind: "complete" | "reschedule" | "delete" | "set_priority"): string {
  const lower = text.toLowerCase();
  let t = text;
  if (kind === "complete") {
    t = lower
      .replace(/^(please\s+)?(mark|complete|finish|done with|check off|tick off|wrap up|done)\s+(the\s+|this\s+|that\s+|my\s+)?/i, "")
      .replace(/\s+(as\s+)?(complete|completed|done|finished|ho gaya|ho gya|khatam)\s*$/i, "")
      .replace(/\s+(complete|done|finished|completed|karo)\s*$/i, "")
      .trim();
  } else if (kind === "reschedule") {
    t = lower
      .replace(/^(please\s+)?(move|shift|push|reschedule|postpone|delay|advance|aage badhao|aage badha do)\s+(the\s+|this\s+|that\s+|my\s+)?/i, "")
      .replace(/\s+(to|ko|tak|by)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next week|next\s+\w+|in\s+.*|the\s+.*)$/i, "")
      .trim();
  } else if (kind === "delete") {
    t = lower
      .replace(/^(please\s+)?(delete|remove|cancel|trash)\s+(the\s+|this\s+|that\s+|my\s+)?/i, "")
      .replace(/\s+(task|item|it|this|that)$/i, "")
      .trim();
  } else {
    t = lower
      .replace(/^(please\s+)?(make|set|change|mark)\s+(the\s+|this\s+|that\s+|my\s+)?/i, "")
      .replace(/\s+(urgent|high priority|critical|low priority|medium priority)\s*$/i, "")
      .trim();
  }
  t = t.replace(/^("|'|the\s+)/, "").replace(/\s*["']$/, "").trim();
  return t;
}

// ─── Main analysis ─────────────────────────────────────────────────────────────

export function analyze(text: string, ctx: AnalyzeContext = {}): Analysis {
  const now = ctx.now ?? Date.now();
  const tz = ctx.timezone ?? "Asia/Kolkata";
  const slugs = ctx.knownProjectSlugs ?? [];
  const { intent, matched } = detectIntent(text);
  const lower = text.toLowerCase();

  const result: Analysis = { intent, matched };

  if (intent === "smalltalk" || intent === "help") {
    return result;
  }

  if (intent === "query_project") {
    result.query = {};
    // find which project is mentioned
    const projectWords: [RegExp, string][] = [
      [/\bkuk\b.*\b(training|implementation|roadmap)\b/, "kuk-training-implementation"],
      [/\b(lecture|lectures|slides|teaching)\b/, "expert-lectures"],
      [/\b(outreach|corporate)\b/, "corporate-outreach"],
      [/\b(intern|internship|student)\b/, "internships-students"],
      [/\bai employees?\b|\bdigital workers?\b/, "ai-employees"],
      [/\brft\b/, "rft"],
      [/\bpersonal\b/, "personal"],
      [/\bidea\b/, "ideas"],
      [/\bkuk\b/, "kuk"],
    ];
    for (const [re, slug] of projectWords) {
      if (re.test(lower)) {
        result.query.projectSlug = slug;
        break;
      }
    }
    if (!result.query.projectSlug) {
      // generic "what do I have" → today
      if (/\btoday\b/.test(lower)) result.query.period = "today";
    }
    return result;
  }

  if (intent === "query_finished") {
    result.query = {};
    if (/\bthis week\b|\bweek\b/.test(lower)) result.query.period = "week";
    else if (/\bthis month\b/.test(lower)) result.query.period = "month";
    else result.query.period = "week";
    return result;
  }

  if (intent === "query_upcoming" || intent === "query_today" || intent === "query_urgent" ||
      intent === "query_overdue" || intent === "query_waiting" || intent === "query_unfinished" ||
      intent === "query_focus") {
    return result;
  }

  if (intent === "briefing" || intent === "evening_review" || intent === "weekly_summary") {
    return result;
  }

  if (intent === "remember") {
    result.rememberText = text
      .replace(/^(please\s+)?(remember that|remember this|remember one thing|remember something|remember|keep in mind that|keep in mind|yaad rakho ki|yaad rakho|note that|note this|note down)\s*[:\-]?\s*/i, "")
      .trim();
    if (!result.rememberText) result.rememberText = text;
    return result;
  }

  if (intent === "create_goal") {
    const horizonRe = /\b(this (week|month|quarter|year)|for (this )?(week|month|quarter|year)|lifetime|life goal)\b/i;
    const hm = horizonRe.exec(text);
    let horizon: string | undefined;
    if (hm) {
      // group 2 = inner word of "this <unit>", group 4 = inner word of "for (this) <unit>"
      const w = hm[2] || hm[4];
      if (/life/i.test(hm[0])) horizon = "life";
      else if (w) horizon = w.toLowerCase();
    }
    let title = text
      .replace(/^(please\s+)?(add|create|set|track|start|note)\s+(a\s+)?(new\s+)?goal\s*[:\-]?\s*/i, "")
      .replace(/^(please\s+)?(my|the)\s+(goal|mission)\s+is\s*[:\-]?\s*/i, "")
      .replace(/^(add|create|set|track)\s+(goal|goals)\s*[:\-]?\s*/i, "")
      .replace(/^goal\s*[:\-]\s*/i, "")
      .trim();
    if (hm) title = title.replace(horizonRe, "").replace(/[\s,\-]+$/, "").trim();
    title = title.replace(/^(to|that)\s+/i, "").trim();
    result.goal = { title: title || text.slice(0, 120), horizon };
    return result;
  }

  if (intent === "query_goals") {
    return result;
  }

  if (intent === "give_feedback") {
    let category = "other";
    let comment = text;
    if (/\b(too early|too soon|pehle ho gaya|pehle aa gaya)\b/i.test(text)) {
      category = "reminder_too_early";
      comment = text;
    } else if (/\b(too late|der ho gayi|der se)\b/i.test(text)) {
      category = "reminder_too_late";
    } else if (/\b(don'?t|do not|stop) (suggesting|suggest|reminding me about|nagging|recommending)\b/i.test(text)) {
      category = "dont_suggest";
    } else if (/\bnot important (anymore|now|to me)\b/i.test(text)) {
      category = "not_important";
    } else if (/\b(make (it|them|this|that)(\s+\w+)? smaller|break (it|this|them|that)(\s+\w+)? (down|into smaller))\b/i.test(text)) {
      category = "make_smaller";
    } else if (/\bi prefer (doing|working|studying|to do)\b/i.test(text)) {
      category = "preferred_time";
    }
    result.feedback = { category, comment };
    return result;
  }

  // Mutations
  if (intent === "complete" || intent === "delete" || intent === "set_priority") {
    result.targetTitle = extractTarget(text, intent);
    return result;
  }

  if (intent === "reschedule") {
    result.targetTitle = extractTarget(text, "reschedule");
    const parsed = parseDatePhrase(text, now, tz);
    if (parsed.at) result.newDeadlineAt = new Date(parsed.at).toISOString();
    return result;
  }

  // Follow-up
  if (intent === "follow_up") {
    const task: TaskDraft = { title: "", isFollowUp: true, taskType: "follow-up" };
    // entity
    const withRe = /\bfollow\s*-?\s*up\s+with\s+(.+?)(?=\s+(about|regarding|on|at|by|ko|in\s+\d|tomorrow|today|kal|next\s+|monday|tuesday|wednesday|thursday|friday|saturday|sunday|if\b|,|$))/i.exec(text);
    const plainRe = /\bfollow\s*-?\s*up\s+(?:on\s+|with\s+)?(.+?)(?=\s+(?:about|regarding|on|at|by|ko|in\s+\d|tomorrow|today|kal|next\s+|monday|tuesday|wednesday|thursday|friday|saturday|sunday|if\b|,|$))/i.exec(text);
    const hinglishEntityRe = /\b([a-z][a-z0-9&.' -]{2,60}?)\s+(?:se|ko)\s+follow\s*[- ]?up\b/i.exec(text);
    const entityMatch = hinglishEntityRe || withRe || plainRe;
    let entity = "";
    if (entityMatch) {
      entity = entityMatch[1]!
        .trim()
        .replace(/^(the|a|an)\s+/i, "")
        .replace(/\s+(karna|karni|karne|karo|karna hai|karni hai|karne hain|karni hain|hai|hain|se|ko)\s*$/i, "")
        .trim();
      if (entity) task.followUp = { entity, reason: "" };
    }
    // reason: "about X"
    const aboutRe = /\b(?:about|regarding)\s+(.+?)(?=\s+(?:at|by|in\s+\d|tomorrow|today|kal|next\s+|monday|tuesday|wednesday|thursday|friday|saturday|sunday|if\b|,)|[.,;!?]?\s*$)/i.exec(text);
    if (aboutRe && task.followUp) task.followUp.reason = aboutRe[1]!.trim();
    if (aboutRe && !task.followUp) task.followUp = { entity: "", reason: aboutRe[1]!.trim() };

    const parsed = parseDatePhrase(text, now, tz);
    if (parsed.at) {
      task.deadlineAt = new Date(parsed.at).toISOString();
      if (task.followUp) task.followUp.at = task.deadlineAt;
    } else {
      const defaultAt = addDays(now, 3);
      task.deadlineAt = new Date(defaultAt).toISOString();
      if (task.followUp) task.followUp.at = task.deadlineAt;
    }

    // "if they don't respond, remind me next Monday"
    const condRe = /\bif (?:they|he|she) (?:don'?t|doesn'?t|do not|does not) respond\b.*\b(remind|notify|alert)\s+me\s+(.+)/i.exec(text);
    if (condRe) {
      const condParsed = parseDatePhrase(condRe[2]!, now, tz);
      if (condParsed.at) {
        task.reminder = { title: `Follow up: ${task.followUp?.entity || "them"}`, at: new Date(condParsed.at).toISOString() };
      }
    }

    task.title = cleanTitle(text, tz, now);
    if (!task.title) task.title = "Follow up";
    task.projectSlug = classifyProject(text, slugs);
    task.priority = computePriority({ text, deadlineAt: task.deadlineAt, taskType: "follow-up", isFollowUp: true, now, timezone: tz });
    task.people = extractPeople(text);
    result.task = task;
    return result;
  }

  // Remind
  if (intent === "remind") {
    const task: TaskDraft = { title: "", taskType: "reminder" };
    const reminderText = text
      .replace(/^(please\s+)?(remind me|set a reminder|set reminder|set an alarm|notify me|alert me|yaad dilana|yaad dilao)\s*(to\s+|that\s+)?/i, "")
      .trim();

    const rem = parseReminderPhrase(text, now, tz);

    // Decide whether the reminder text contains a real action (→ also create a task)
    const cleaned = cleanTitle(reminderText, tz, now);
    const hasAction = cleaned.length > 3 && !/^(remind|reminder|notification|alarm)$/i.test(cleaned);

    if (rem.recurrence) {
      task.recurrence = rem.recurrence;
      task.reminder = { title: cleaned || "Reminder", recurrence: rem.recurrence };
      if (rem.at) task.reminder.at = new Date(rem.at).toISOString();
    } else if (rem.offsetBeforeDeadline !== undefined) {
      task.reminder = { title: cleaned || "Reminder", offsetBeforeDeadline: rem.offsetBeforeDeadline };
    } else if (rem.at) {
      task.reminder = { title: cleaned || "Reminder", at: new Date(rem.at).toISOString() };
    }

    if (hasAction) {
      task.title = cleaned;
      task.taskType = "task";
      const parsed = parseDatePhrase(text, now, tz);
      if (parsed.at && !task.reminder?.offsetBeforeDeadline) {
        // if the reminder is at a specific time, the task deadline matches it
        task.deadlineAt = new Date(parsed.at).toISOString();
      }
      if (task.reminder?.at && !task.deadlineAt) task.deadlineAt = task.reminder.at;
      task.projectSlug = classifyProject(text, slugs);
      task.priority = computePriority({ text, deadlineAt: task.deadlineAt, taskType: "task", now, timezone: tz });
      task.people = extractPeople(text);
      if (task.reminder?.offsetBeforeDeadline && task.deadlineAt) {
        task.reminder.at = new Date(applyOffset(new Date(task.deadlineAt).getTime(), task.reminder.offsetBeforeDeadline)).toISOString();
      }
    } else {
      task.title = cleaned || "Reminder";
    }
    result.task = task;
    return result;
  }

  // Default: create task
  const task: TaskDraft = { title: "", taskType: "task" };
  const parsed = parseDatePhrase(text, now, tz);
  if (parsed.at) {
    task.deadlineAt = new Date(parsed.at).toISOString();
    const p = zonedParts(parsed.at, tz);
    task.dueDate = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    const hasExplicitTime = /am|pm|baje|o'clock|:/.test(lower) || /\b(morning|afternoon|evening|tonight|noon|midnight)\b/.test(lower) || parseWordTime(text) !== null;
    if (hasExplicitTime) {
      task.dueTime = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    }
  }

  task.title = cleanTitle(text, tz, now);
  if (!task.title) task.title = "New task";
  task.projectSlug = classifyProject(text, slugs);
  task.priority = computePriority({ text, deadlineAt: task.deadlineAt, taskType: "task", now, timezone: tz });
  task.people = extractPeople(text);

  // Auto-reminder for deadlines: 1h before if due today, else 9:00 AM on
  // the deadline day (or 1h before if the deadline is earlier than that).
  if (task.deadlineAt && !task.reminder) {
    const deadlineMs = new Date(task.deadlineAt).getTime();
    const start = todayStart(now, tz);
    if (deadlineMs < start + 24 * HOUR) {
      task.reminder = { title: task.title, at: new Date(deadlineMs - 60 * MINUTE).toISOString() };
    } else {
      const dayStart = todayStart(deadlineMs, tz);
      const at = Math.min(dayStart + 9 * HOUR, deadlineMs - 60 * MINUTE);
      task.reminder = { title: task.title, at: new Date(at).toISOString() };
    }
  }

  result.task = task;
  return result;
}