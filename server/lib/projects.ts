/**
 * Project classification. Deterministic keyword scoring over the user's
 * known projects, with Hinglish-aware token stems. Falls back to General.
 */

export interface ProjectRule {
  slug: string;
  keywords: string[];
}

const RULES: ProjectRule[] = [
  {
    slug: "kuk-training-implementation",
    keywords: [
      "roadmap", "training roadmap", "implementation", "train the trainer",
      "kuk training", "implementation plan", "training plan", "onboarding plan",
      "faculty training", "curriculum rollout",
    ],
  },
  {
    slug: "expert-lectures",
    keywords: [
      "lecture", "lectures", "slides", "presentation", "talk", "session",
      "speaker", "guest lecture", "class", "workshop", "webinar", "demo class",
      "12:30", "lecture ke liye", "wali lecture", "teaching", "seminar",
    ],
  },
  {
    slug: "corporate-outreach",
    keywords: [
      "outreach", "corporate", "company", "companies", "scrape", "scraped",
      "sponsor", "sponsorship", "partnership", "partner", "hr", "recruiter",
      "cold email", "prospect", "client meeting", "clients", "pitch deck",
    ],
  },
  {
    slug: "internships-students",
    keywords: [
      "intern", "interns", "internship", "student", "students", "final year",
      "placement", "resume", "cv", "mentor", "mentorship", "project guide",
      "ma'am", "sir", "hod", "principal", "faculty",
    ],
  },
  {
    slug: "ai-employees",
    keywords: [
      "ai employee", "ai employees", "employee", "digital worker", "agent",
      "ceo", "pitch", "ai pitch", "ai workforce", "automation", "copilot",
      "ai agents", "ai assistant", "bot",
    ],
  },
  {
    slug: "rft",
    keywords: [
      "rft", "report", "audit", "compliance", "tax", "filing", "gst",
      "account", "finance", "invoice", "budget",
    ],
  },
  {
    slug: "ideas",
    keywords: [
      "idea", "ideas", "brainstorm", "concept", "thought", "maybe build",
      "what if", "think about",
    ],
  },
  {
    slug: "personal",
    keywords: [
      "personal", "family", "home", "gym", "doctor", "dentist", "bank",
      "bill", "grocer", "birthday", "anniversary", "friend", "mom", "dad",
      "mum", "wife", "husband", "brother", "sister",
    ],
  },
  {
    slug: "kuk",
    keywords: [
      "kuk", "kurukshetra university", "university", "vice chancellor",
      "vc ", "registrar", "department", "exam", "admission", "semester",
      "college", "syllabus", "academic",
    ],
  },
];

/** Score a phrase against a rule; returns match weight. */
export function classifyProject(text: string, knownSlugs: string[] = []): string {
  const lower = text.toLowerCase();

  // Explicit project name mention wins ("Add to KUK", "KUK ka task")
  const known = new Set(knownSlugs);
  if (known.has("kuk-training-implementation") && /\bkuk\b.*\b(training|implementation|roadmap)\b/.test(lower)) {
    return "kuk-training-implementation";
  }
  if (known.has("expert-lectures") && /\b(lecture|lectures|slides)\b/.test(lower)) return "expert-lectures";
  if (known.has("corporate-outreach") && /\b(outreach|corporate)\b/.test(lower)) return "corporate-outreach";
  if (known.has("internships-students") && /\b(intern|internship|student)\b/.test(lower)) return "internships-students";
  if (known.has("ai-employees") && /\b(ai employee|ai employees|digital worker)\b/.test(lower)) return "ai-employees";
  if (known.has("rft") && /\brft\b/.test(lower)) return "rft";
  if (known.has("personal") && /\bpersonal\b/.test(lower)) return "personal";
  if (known.has("ideas") && /\bidea\b/.test(lower)) return "ideas";

  // Scored keyword matching
  let best = "general";
  let bestScore = 0;
  for (const rule of RULES) {
    let score = 0;
    for (const kw of rule.keywords) {
      if (lower.includes(kw)) score += kw.length > 8 ? 3 : 2;
    }
    // Hinglish morphology: "lecture ke liye", "outreach team"
    if (rule.slug === "kuk" && /\bkuk\b/.test(lower)) score += 4;
    if (score > bestScore) {
      bestScore = score;
      best = rule.slug;
    }
  }
  return best;
}

export const PROJECT_SLUGS = RULES.map((r) => r.slug);