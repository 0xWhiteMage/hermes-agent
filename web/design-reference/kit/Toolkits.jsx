/* eslint-disable react/prop-types */
/* Toolkit data + small brand-glyph component used across the
   Connected Tools page and the Admin Toolkit Catalog page.

   Glyphs are drawn inline SVG; not pixel-accurate brand logos
   but recognisable shapes-and-colours stand-ins. */

const TOOLKITS = [
  // slug              name              category        toolCount  brand
  { slug: "gmail",        name: "Gmail",          category: "Communication", tools: 27, brand: "#EA4335", description: "Send & manage email." },
  { slug: "slack",        name: "Slack",          category: "Communication", tools: 38, brand: "#611F69", description: "Channels, DMs, messages." },
  { slug: "github",       name: "GitHub",         category: "Dev Tools",     tools: 145, brand: "#0A0A0A", description: "Repos, PRs, issues, code." },
  { slug: "linear",       name: "Linear",         category: "Project Mgmt",  tools: 41, brand: "#5E6AD2", description: "Issues, projects, cycles." },
  { slug: "notion",       name: "Notion",         category: "Productivity",  tools: 33, brand: "#0A0A0A", description: "Pages, databases, blocks." },
  { slug: "googlecalendar", name: "Google Calendar", category: "Productivity", tools: 18, brand: "#4285F4", description: "Events & scheduling." },
  { slug: "googlesheets", name: "Google Sheets",  category: "Productivity",  tools: 22, brand: "#0F9D58", description: "Spreadsheets, ranges, formulas." },
  { slug: "googledocs",   name: "Google Docs",    category: "Productivity",  tools: 19, brand: "#4285F4", description: "Documents & comments." },
  { slug: "googledrive",  name: "Google Drive",   category: "Productivity",  tools: 24, brand: "#FBBC04", description: "Files, folders, sharing." },
  { slug: "outlook",      name: "Outlook",        category: "Communication", tools: 29, brand: "#0078D4", description: "Email & calendar." },
  { slug: "jira",         name: "Jira",           category: "Project Mgmt",  tools: 52, brand: "#0052CC", description: "Issues, sprints, boards." },
  { slug: "hubspot",      name: "HubSpot",        category: "CRM",           tools: 67, brand: "#FF7A59", description: "Contacts, deals, marketing." },
  { slug: "salesforce",   name: "Salesforce",     category: "CRM",           tools: 84, brand: "#00A1E0", description: "Accounts, opportunities, leads." },
  { slug: "airtable",     name: "Airtable",       category: "Productivity",  tools: 26, brand: "#F82B60", description: "Bases, tables, records." },
  { slug: "discord",      name: "Discord",        category: "Communication", tools: 21, brand: "#5865F2", description: "Servers, channels, messages." },
  { slug: "twitter",      name: "X (Twitter)",    category: "Social",        tools: 17, brand: "#0A0A0A", description: "Tweets, DMs, followers." },
  { slug: "youtube",      name: "YouTube",        category: "Social",        tools: 14, brand: "#FF0000", description: "Videos, channels, comments." },
  { slug: "supabase",     name: "Supabase",       category: "Dev Tools",     tools: 31, brand: "#3ECF8E", description: "Postgres, auth, storage." },
  { slug: "firecrawl",    name: "Firecrawl",      category: "Web & Search",  tools: 9,  brand: "#FF6A00", description: "Crawl & extract pages." },
  { slug: "perplexityai", name: "Perplexity",     category: "Web & Search",  tools: 7,  brand: "#1F8FAE", description: "Search & answer." },
  { slug: "serpapi",      name: "SerpAPI",        category: "Web & Search",  tools: 12, brand: "#6A48F7", description: "Google search results." },
  { slug: "tavily",       name: "Tavily",         category: "Web & Search",  tools: 6,  brand: "#3B82F6", description: "AI-native web search." },
  { slug: "codeinterpreter", name: "Code Interpreter", category: "Dev Tools", tools: 5, brand: "#1B40FF", description: "Run code in a sandbox." },
  { slug: "stripe",       name: "Stripe",         category: "Finance",       tools: 48, brand: "#635BFF", description: "Payments, customers, invoices." },
  { slug: "intercom",     name: "Intercom",       category: "Support",       tools: 23, brand: "#1F8DED", description: "Conversations, contacts." },
  { slug: "zendesk",      name: "Zendesk",        category: "Support",       tools: 28, brand: "#03363D", description: "Tickets, users, macros." },
  { slug: "asana",        name: "Asana",          category: "Project Mgmt",  tools: 35, brand: "#F06A6A", description: "Tasks & projects." },
  { slug: "trello",       name: "Trello",         category: "Project Mgmt",  tools: 16, brand: "#0079BF", description: "Boards & cards." },
  { slug: "confluence",   name: "Confluence",     category: "Productivity",  tools: 24, brand: "#172B4D", description: "Wiki pages, spaces." },
  { slug: "dropbox",      name: "Dropbox",        category: "Productivity",  tools: 18, brand: "#0061FF", description: "Files & folders." },
  { slug: "figma",        name: "Figma",          category: "Design",        tools: 11, brand: "#F24E1E", description: "Files, frames, comments." },
  { slug: "monday",       name: "Monday.com",     category: "Project Mgmt",  tools: 32, brand: "#FF3D57", description: "Boards & workflows." },
  { slug: "shopify",      name: "Shopify",        category: "Finance",       tools: 56, brand: "#96BF48", description: "Products, orders, customers." },
];

const CATEGORIES = [
  "All", "Communication", "Dev Tools", "Productivity",
  "Project Mgmt", "CRM", "Web & Search", "Social",
  "Finance", "Support", "Design",
];

/* The "Recommended" tool list for each toolkit — used in the slide-over.
   In production this would come from Composio's metadata. Here we hand-roll
   a handful for the most-used toolkits so the slide-over isn't empty. */
const RECOMMENDED_TOOLS = {
  gmail: [
    { slug: "GMAIL_SEND_EMAIL", name: "Send email", desc: "Compose and send a new email." },
    { slug: "GMAIL_LIST_THREADS", name: "List threads", desc: "Fetch recent threads with filters." },
    { slug: "GMAIL_FETCH_EMAILS", name: "Fetch emails", desc: "Read message bodies by query." },
    { slug: "GMAIL_REPLY_TO_THREAD", name: "Reply to thread", desc: "Reply in-line on a thread." },
    { slug: "GMAIL_CREATE_DRAFT", name: "Create draft", desc: "Save a draft without sending." },
    { slug: "GMAIL_ADD_LABEL", name: "Add label", desc: "Apply a label to a message." },
    { slug: "GMAIL_SEARCH", name: "Search messages", desc: "Full-text Gmail search." },
  ],
  slack: [
    { slug: "SLACK_SEND_MESSAGE", name: "Send message", desc: "Post to a channel or user." },
    { slug: "SLACK_LIST_CHANNELS", name: "List channels", desc: "All channels in the workspace." },
    { slug: "SLACK_FETCH_HISTORY", name: "Fetch history", desc: "Recent messages from a channel." },
    { slug: "SLACK_REPLY_THREAD", name: "Reply in thread", desc: "Reply inside a thread." },
    { slug: "SLACK_ADD_REACTION", name: "Add reaction", desc: "Emoji react to a message." },
    { slug: "SLACK_LIST_USERS", name: "List users", desc: "Members of the workspace." },
    { slug: "SLACK_UPLOAD_FILE", name: "Upload file", desc: "Share a file to a channel." },
  ],
  github: [
    { slug: "GITHUB_CREATE_ISSUE", name: "Create issue", desc: "Open a new issue in a repo." },
    { slug: "GITHUB_LIST_PRS", name: "List pull requests", desc: "PRs in a repo, filtered." },
    { slug: "GITHUB_COMMENT_ON_ISSUE", name: "Comment on issue", desc: "Reply on an issue or PR." },
    { slug: "GITHUB_GET_REPO_CONTENT", name: "Get repo content", desc: "Read a file or dir." },
    { slug: "GITHUB_SEARCH_CODE", name: "Search code", desc: "Code search across repos." },
    { slug: "GITHUB_CREATE_BRANCH", name: "Create branch", desc: "Branch off a base ref." },
    { slug: "GITHUB_OPEN_PR", name: "Open pull request", desc: "File a PR against base." },
  ],
  linear: [
    { slug: "LINEAR_CREATE_ISSUE", name: "Create issue", desc: "New issue with title, body, team." },
    { slug: "LINEAR_LIST_ISSUES", name: "List issues", desc: "Filter by status, assignee, team." },
    { slug: "LINEAR_UPDATE_ISSUE", name: "Update issue", desc: "Change status, assignee, priority." },
    { slug: "LINEAR_LIST_PROJECTS", name: "List projects", desc: "Projects in a team." },
    { slug: "LINEAR_ADD_COMMENT", name: "Add comment", desc: "Comment on an issue." },
    { slug: "LINEAR_LIST_TEAMS", name: "List teams", desc: "All teams in the workspace." },
  ],
  notion: [
    { slug: "NOTION_CREATE_PAGE", name: "Create page", desc: "New page in a database/parent." },
    { slug: "NOTION_QUERY_DATABASE", name: "Query database", desc: "Filter & sort database rows." },
    { slug: "NOTION_UPDATE_PAGE", name: "Update page", desc: "Edit properties or content." },
    { slug: "NOTION_GET_PAGE", name: "Get page", desc: "Fetch a page and its blocks." },
    { slug: "NOTION_APPEND_BLOCKS", name: "Append blocks", desc: "Add content to a page." },
  ],
  googlecalendar: [
    { slug: "GCAL_CREATE_EVENT", name: "Create event", desc: "Schedule a new event." },
    { slug: "GCAL_LIST_EVENTS", name: "List events", desc: "Events in a window, calendar." },
    { slug: "GCAL_UPDATE_EVENT", name: "Update event", desc: "Reschedule or edit." },
    { slug: "GCAL_DELETE_EVENT", name: "Delete event", desc: "Cancel an event." },
    { slug: "GCAL_FIND_FREE", name: "Find free time", desc: "Free/busy across calendars." },
  ],
};

/* The starter pack — first-visit "enable these" promos. Admin-configurable in
   the catalog page. */
const STARTER_PACK = ["gmail", "slack", "github", "linear", "notion", "googlecalendar"];

/* Brand-colour glyph. We don't have real brand SVGs — draw a coloured tile
   with the first letter in white (or contrast). Stays consistent regardless
   of toolkit; the colour is the recognisable cue. */
function BrandGlyph({ toolkit, size = 36 }) {
  if (!toolkit) return null;
  const initials = toolkit.name
    .replace(/\(.*\)/, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  // For some toolkits we have a hand-drawn glyph.
  const custom = CUSTOM_GLYPHS[toolkit.slug];
  if (custom) {
    return (
      <span
        className="brand-glyph"
        style={{ width: size, height: size, background: toolkit.brand + "14", color: toolkit.brand, borderColor: toolkit.brand + "33" }}
        aria-hidden
      >
        {custom(size * 0.6, toolkit.brand)}
      </span>
    );
  }
  // Pick a readable foreground: white over saturated, otherwise the brand colour itself on tint.
  return (
    <span
      className="brand-glyph"
      style={{ width: size, height: size, background: toolkit.brand, color: "#fff" }}
      aria-hidden
    >
      <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: size * 0.42, letterSpacing: -0.5 }}>
        {initials}
      </span>
    </span>
  );
}

/* Custom hand-drawn glyphs. Use `currentColor` so BrandGlyph's parent
   `color: toolkit.brand` cascades — the glyph draws in the toolkit's own
   colour on a soft tint of the same colour. */
const CUSTOM_GLYPHS = {
  slack: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      {/* Slack is intentionally multi-coloured — its mark is the brand. */}
      <rect x="3" y="10" width="6" height="3" rx="1.5" fill="#36C5F0"/>
      <rect x="11" y="3" width="3" height="6" rx="1.5" fill="#2EB67D"/>
      <rect x="15" y="11" width="6" height="3" rx="1.5" fill="#ECB22E"/>
      <rect x="10" y="15" width="3" height="6" rx="1.5" fill="#E01E5A"/>
    </svg>
  ),
  github: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2a10 10 0 0 0-3.16 19.5c.5.1.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.15-1.1-1.45-1.1-1.45-.9-.62.07-.6.07-.6 1 .07 1.52 1.03 1.52 1.03.88 1.52 2.32 1.08 2.88.82.1-.65.36-1.08.65-1.33-2.22-.25-4.55-1.1-4.55-4.94 0-1.1.38-2 1.03-2.7-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03a9.4 9.4 0 0 1 5 0c1.9-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.7 0 3.85-2.34 4.7-4.57 4.94.37.32.7.94.7 1.9v2.8c0 .27.18.59.7.49A10 10 0 0 0 12 2"/>
    </svg>
  ),
  linear: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 13.1A9 9 0 0 1 10.9 21M3 9.6A12.5 12.5 0 0 1 14.4 21M3 6.4A15.7 15.7 0 0 1 17.6 21M5 4.8a18.3 18.3 0 0 1 14.2 14.2M8.2 3.5a17.6 17.6 0 0 1 12.3 12.3M12.6 3a14 14 0 0 1 8.4 8.4M17.5 3.8a9.3 9.3 0 0 1 2.7 2.7"/>
    </svg>
  ),
  notion: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/>
      <path d="M8 9v9M8 9l8 9M16 9v9"/>
    </svg>
  ),
  gmail: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <rect x="3" y="5.5" width="18" height="13" rx="1.5"/>
      <path d="M3 6.5 12 13l9-6.5"/>
    </svg>
  ),
  googlecalendar: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <rect x="4" y="5" width="16" height="15" rx="1.5"/>
      <path d="M4 9h16M8 4v3M16 4v3"/>
      <text x="12" y="17" textAnchor="middle" fill="currentColor" stroke="none" style={{ fontSize: 7, fontWeight: 700, fontFamily: "var(--font-auxiliary)" }}>25</text>
    </svg>
  ),
  twitter: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor">
      <path d="m4 4 7 9-7 7h2l6-6 5 6h4l-8-10 7-6h-2l-6 5-4-5z"/>
    </svg>
  ),
  discord: (s) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 5.2A14 14 0 0 0 15.5 4l-.4.7a12 12 0 0 0-6.2 0L8.5 4A14 14 0 0 0 5 5.2C2.6 9 2 12.4 2.1 15.8a14 14 0 0 0 4.2 2.1l.9-1.2c-.6-.2-1.1-.5-1.6-.8.1-.1.3-.2.4-.3a10 10 0 0 0 9 0l.4.3c-.5.3-1 .6-1.6.8l.9 1.2a14 14 0 0 0 4.2-2.1c.3-3.8-.7-7.2-2.9-10.6ZM8.9 14a1.7 2 0 1 1 0-3.9 1.7 2 0 0 1 0 3.9zm6.2 0a1.7 2 0 1 1 0-3.9 1.7 2 0 0 1 0 3.9z"/>
    </svg>
  ),
};

Object.assign(window, {
  TOOLKITS, CATEGORIES, RECOMMENDED_TOOLS, STARTER_PACK, BrandGlyph,
});
