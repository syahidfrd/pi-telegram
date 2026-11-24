// pi-telegram: talk to your running pi session from Telegram.
//
// Messages from allowed Telegram users become user messages in the open pi session (steering pi if it
// is busy); when a run started from Telegram ends, pi's last answer goes back to the chat as formatted
// text. Photos, files and voice notes are saved to an inbox folder; voice notes and images can be
// transcribed by any OpenAI-compatible API. Optional generate_image tool (OpenAI Images).
// Scheduler: pi can schedule recurring tasks (cron) that run in this session and report to Telegram.
//
// The extension stays idle unless PI_TELEGRAM_BOT_TOKEN is set, so installing it globally is safe.
// Only one pi process may poll a bot token at a time.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ---------- config (env vars, or ~/.pi/agent/telegram.json with the same keys) ----------
const CONFIG_FILE = join(homedir(), ".pi", "agent", "telegram.json");
const fileCfg: Record<string, string> = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : {};
const cfg = (k: string, d = "") => (process.env[k] ?? fileCfg[k] ?? d).toString().trim();

const TOKEN = cfg("PI_TELEGRAM_BOT_TOKEN");
const ALLOW = new Set(cfg("PI_TELEGRAM_ALLOWED_USERS").split(",").map((x) => Number(x.trim())).filter(Boolean));
const INBOX = resolve(cfg("PI_TELEGRAM_INBOX", "./telegram-inbox"));
const STATE = join(homedir(), ".pi", "agent", "telegram-state.json");
const LOG = cfg("PI_TELEGRAM_LOG"); // optional log file path
const SCHEDULES = join(homedir(), ".pi", "agent", "telegram-schedules.json");
const TZ = cfg("PI_TELEGRAM_TIMEZONE", Intl.DateTimeFormat().resolvedOptions().timeZone);

// Optional helpers, any OpenAI-compatible endpoint (OpenAI, Groq, OpenRouter, Sumopod, ...)
const VISION = { url: cfg("PI_TELEGRAM_VISION_BASE_URL", "https://api.openai.com/v1"), key: cfg("PI_TELEGRAM_VISION_API_KEY"), model: cfg("PI_TELEGRAM_VISION_MODEL", "gpt-4o-mini") };
const STT = { url: cfg("PI_TELEGRAM_STT_BASE_URL", "https://api.groq.com/openai/v1"), key: cfg("PI_TELEGRAM_STT_API_KEY"), model: cfg("PI_TELEGRAM_STT_MODEL", "whisper-large-v3-turbo") };
const IMAGE = { url: cfg("PI_TELEGRAM_IMAGE_BASE_URL", "https://api.openai.com/v1"), key: cfg("PI_TELEGRAM_IMAGE_API_KEY"), model: cfg("PI_TELEGRAM_IMAGE_MODEL", "gpt-image-1") };

const g = globalThis as any; // survives extension rebinds on /new and /resume
g.piTelegram ??= { polling: false, pi: null, ctx: null, chat: null, fromTelegram: false };
const st = g.piTelegram;

function log(msg: string) {
  if (!LOG) return;
  try { appendFileSync(LOG, `${new Date().toLocaleString("sv-SE")} ${msg}\n`); } catch {}
}

async function api(method: string, params: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params),
    signal: AbortSignal.timeout(70_000),
  });
  return r.json() as Promise<any>;
}

// ---------- Markdown -> Telegram HTML ----------
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Telegram has no tables: each Markdown table row becomes a small card (first column bold, then "Header: value").
export function tablesToCards(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("|") && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = cells(lines[i]);
      i += 2;
      const cards: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const row = cells(lines[i]);
        // a leading "#"/number column is folded into the title ("1. Name")
        const numbered = /^(#|no\.?|)$/i.test(head[0] || "") && /^\d+\.?$/.test(row[0] || "");
        const t0 = numbered ? 1 : 0;
        const title = `${numbered ? row[0].replace(/\.$/, "") + ". " : ""}${(row[t0] || "").replace(/\*\*/g, "")}`;
        const empty = (v: string) => !v || /^[-–—]$/.test(v);
        const rest = row.map((v, j) => (j <= t0 || empty(v) ? "" : `${head[j] || ""}: ${v}`)).filter(Boolean);
        cards.push([`**${title}**`, ...rest].join("\n"));
        i++;
      }
      i--;
      out.push(cards.join("\n\n"));
    } else out.push(lines[i]);
  }
  return out.join("\n");
}

export function mdToHtml(md: string): string {
  md = tablesToCards(md);
  const keep: string[] = [];
  const stash = (h: string) => `\u0000${keep.push(h) - 1}\u0000`;
  let s = md.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code) => stash(`<pre>${esc(code.replace(/\n$/, ""))}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => stash(`<code>${esc(code)}</code>`));
  s = esc(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t, u) => `<a href="${u.replace(/"/g, "&quot;")}">${t}</a>`);
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  s = s.replace(/^&gt;\s?(.*)$/gm, "<blockquote>$1</blockquote>").replace(/<\/blockquote>\n<blockquote>/g, "\n");
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/__(.+?)__/g, "<b>$1</b>");
  s = s.replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,!?:;]|$)/gm, "$1<i>$2</i>");
  s = s.replace(/(^|[\s(])_(?!\s)([^_\n]+?)_(?=[\s).,!?:;]|$)/gm, "$1<i>$2</i>");
  s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");
  s = s.replace(/^(\s*)[-*]\s+/gm, "$1• ");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => keep[Number(i)]);
}

function chunks(text: string, max = 3500): string[] {
  const out: string[] = [];
  let cur = "", inFence = false;
  for (const line of text.split("\n")) {
    if ((cur + line).length > max && cur && !inFence) { out.push(cur); cur = ""; }
    if (line.trim().startsWith("```")) inFence = !inFence;
    cur += (cur ? "\n" : "") + line;
  }
  if (cur) out.push(cur);
  return out.flatMap((c) => (c.length > 4000 ? c.match(/[\s\S]{1,4000}/g) || [] : [c]));
}

async function send(chat: number, text: string) {
  text = text.trim() || "(pi finished without text)";
  for (const part of chunks(text)) {
    try {
      const r = await api("sendMessage", { chat_id: chat, text: mdToHtml(part), parse_mode: "HTML", disable_web_page_preview: true });
      if (!r.ok) { log(`html rejected: ${r.description}`); await api("sendMessage", { chat_id: chat, text: part }); }
    } catch (e) { log(`send error ${e}`); }
  }
}

async function sendFile(chat: number, path: string, caption = "") {
  const form = new FormData();
  form.append("chat_id", String(chat));
  if (caption) form.append("caption", caption.slice(0, 1000));
  form.append("document", new Blob([readFileSync(path)]), path.split("/").pop());
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
}

function textOf(m: any): string {
  const c = m?.content;
  if (typeof c === "string") return c;
  return (c || []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
}

// ---------- attachments ----------
async function fetchFile(fileId: string, name: string) {
  const f = await api("getFile", { file_id: fileId });
  if (!f.ok) throw new Error(f.description || "getFile failed");
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.result.file_path}`, { signal: AbortSignal.timeout(120_000) });
  const buf = Buffer.from(await r.arrayBuffer());
  mkdirSync(INBOX, { recursive: true });
  const stamp = new Date().toLocaleString("sv-SE").replace(/[-: ]/g, "").slice(0, 14);
  const path = join(INBOX, `${stamp}-${name.replace(/[^\w.\-]+/g, "_").slice(-80)}`);
  writeFileSync(path, buf);
  return { path, buf };
}

async function describeImage(buf: Buffer, mime: string) {
  const r = await fetch(`${VISION.url}/chat/completions`, {
    method: "POST", signal: AbortSignal.timeout(90_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${VISION.key}` },
    body: JSON.stringify({ model: VISION.model, max_tokens: 1500, messages: [{ role: "user", content: [
      { type: "text", text: "Transcribe all visible text in this image exactly (numbers, tables, names), then briefly describe the image. Answer in the language of the text." },
      { type: "image_url", image_url: { url: `data:${mime};base64,${buf.toString("base64")}` } },
    ] }] }),
  });
  const d: any = await r.json();
  return d.choices?.[0]?.message?.content || `(vision failed: ${JSON.stringify(d).slice(0, 200)})`;
}

async function transcribe(buf: Buffer, name: string) {
  const form = new FormData();
  form.append("model", STT.model);
  form.append("file", new Blob([buf]), name);
  const r = await fetch(`${STT.url}/audio/transcriptions`, {
    method: "POST", body: form, headers: { authorization: `Bearer ${STT.key}` }, signal: AbortSignal.timeout(120_000),
  });
  const d: any = await r.json();
  if (!d.text) throw new Error(JSON.stringify(d).slice(0, 200));
  return d.text.trim();
}

async function attachment(m: any): Promise<string | null> {
  let fileId = "", name = "", mime = "";
  if (m.photo?.length) { const p = m.photo[m.photo.length - 1]; fileId = p.file_id; name = "photo.jpg"; mime = "image/jpeg"; }
  else if (m.voice || m.audio) { const a = m.voice || m.audio; fileId = a.file_id; name = a.file_name || "voice.ogg"; mime = a.mime_type || "audio/ogg"; }
  else if (m.document) { fileId = m.document.file_id; name = m.document.file_name || "file"; mime = m.document.mime_type || ""; }
  else return null;
  const { path, buf } = await fetchFile(fileId, name);
  log(`attachment ${name} ${buf.length} bytes`);
  if (mime.startsWith("audio/")) {
    if (!STT.key) return `Voice note saved at ${path} (no PI_TELEGRAM_STT_API_KEY set, so it was not transcribed).`;
    return `Voice note from Telegram (${path}), transcript:\n"${await transcribe(buf, name)}"\nTreat the transcript as the user's message.`;
  }
  let note = `File from Telegram saved at ${path} (${Math.round(buf.length / 1024)} KB${mime ? ", " + mime : ""}).`;
  if (mime.startsWith("image/") && VISION.key) {
    note += `\nWhat a vision model (${VISION.model}) reads in the image:\n${await describeImage(buf, mime)}`;
  }
  return note;
}

// ---------- optional tool: generate_image ----------
function registerTools(pi: ExtensionAPI) {
  if (!IMAGE.key) return;
  pi.registerTool({
    name: "generate_image",
    label: "Generate image",
    description: "Generate an image from a detailed English prompt. Saves a PNG in the inbox folder and sends it to the user's Telegram chat.",
    promptSnippet: "Generate an image and send it to the user's Telegram",
    promptGuidelines: [
      "Use generate_image for visuals the user asks for; write a detailed English prompt and pick size 1024x1536 for portrait social posts.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Detailed English image prompt" }),
      size: Type.Optional(Type.String({ description: "1024x1536 (portrait, default), 1024x1024 or 1536x1024" })),
    }),
    async execute(_id: string, params: any) {
      const r = await fetch(`${IMAGE.url}/images/generations`, {
        method: "POST", signal: AbortSignal.timeout(240_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${IMAGE.key}` },
        body: JSON.stringify({ model: IMAGE.model, prompt: params.prompt, size: params.size || "1024x1536", n: 1 }),
      });
      const d: any = await r.json();
      const b64 = d.data?.[0]?.b64_json;
      if (!b64) return { content: [{ type: "text", text: `Image generation failed: ${JSON.stringify(d.error || d).slice(0, 400)}` }], details: {} };
      mkdirSync(INBOX, { recursive: true });
      const path = join(INBOX, `image-${Date.now()}.png`);
      writeFileSync(path, Buffer.from(b64, "base64"));
      if (st.chat) { try { await sendFile(st.chat, path); } catch (e) { log(`sendFile error ${e}`); } }
      return { content: [{ type: "text", text: `Image saved at ${path}${st.chat ? " and sent to the user's Telegram" : ""}.` }], details: { path } };
    },
  });
}


// ---------- scheduler: pi works on its own and reports to Telegram ----------
// Standard 5-field cron (minute hour day-of-month month day-of-week) in PI_TELEGRAM_TIMEZONE.
type Schedule = { id: string; cron: string; prompt: string; chat: number; last?: string };

function loadSchedules(): Schedule[] {
  try { return JSON.parse(readFileSync(SCHEDULES, "utf8")); } catch { return []; }
}
function saveSchedules(s: Schedule[]) {
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
  writeFileSync(SCHEDULES, JSON.stringify(s, null, 1));
}

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(",").some((part) => {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    let lo = min, hi = max;
    if (range !== "*") {
      const [a, b] = range.split("-").map(Number);
      lo = a; hi = b ?? (stepStr ? max : a);
    }
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

export function cronValid(cron: string): boolean {
  const f = cron.trim().split(/\s+/);
  return f.length === 5 && f.every((x) => /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/.test(x));
}

export function cronMatches(cron: string, d: Date, tz = TZ): boolean {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  const [mi, h, dom, mon, dw] = cron.trim().split(/\s+/);
  const dowOk = fieldMatches(dw, dow, 0, 6) || (dow === 0 && fieldMatches(dw, 7, 0, 7));
  return fieldMatches(mi, Number(p.minute), 0, 59) && fieldMatches(h, Number(p.hour) % 24, 0, 23) &&
    fieldMatches(dom, Number(p.day), 1, 31) && fieldMatches(mon, Number(p.month), 1, 12) && dowOk;
}

function runDue(pi: ExtensionAPI) {
  const now = new Date();
  const minute = now.toISOString().slice(0, 16);
  const all = loadSchedules();
  let changed = false;
  for (const s of all) {
    if (s.last === minute || !cronMatches(s.cron, now)) continue;
    s.last = minute; changed = true;
    st.chat = s.chat; st.fromTelegram = true;
    log(`schedule ${s.id} fired`);
    const msg = `[Scheduled task ${s.id}, cron "${s.cron}"] ${s.prompt}`;
    try {
      if (st.ctx?.isIdle()) st.pi.sendUserMessage(msg);
      else st.pi.sendUserMessage(msg, { deliverAs: "followUp" });
    } catch (e) { log(`schedule inject error ${e}`); }
  }
  if (changed) saveSchedules(all);
}

function registerScheduleTools(pi: ExtensionAPI) {
  const ok = (text: string) => ({ content: [{ type: "text", text }], details: {} });
  pi.registerTool({
    name: "schedule_add",
    label: "Schedule task",
    description: `Schedule a recurring task: at each cron match, the prompt is sent to this pi session and the answer goes to the user's Telegram. Cron is 5 fields (minute hour day month weekday) in ${TZ}.`,
    promptSnippet: "Schedule recurring tasks that report to the user's Telegram",
    promptGuidelines: [
      `Use schedule_add when the user asks for something to happen regularly or later (e.g. "every Monday 8am", "daily at 17:00"); times are in ${TZ}. Write the prompt so it is self-contained, since it runs later without this conversation.`,
    ],
    parameters: Type.Object({
      cron: Type.String({ description: "5-field cron, e.g. '0 8 * * 1' = Mondays 08:00" }),
      prompt: Type.String({ description: "What pi should do each time, self-contained" }),
    }),
    async execute(_id: string, params: any) {
      if (!cronValid(params.cron)) return ok(`Invalid cron "${params.cron}". Use 5 fields: minute hour day month weekday.`);
      const chat = st.chat || [...ALLOW][0];
      const all = loadSchedules();
      const id = Math.random().toString(36).slice(2, 7);
      all.push({ id, cron: params.cron.trim(), prompt: params.prompt, chat });
      saveSchedules(all);
      log(`schedule ${id} added: ${params.cron}`);
      return ok(`Scheduled ${id}: "${params.cron}" (${TZ}). Results go to Telegram chat ${chat}.`);
    },
  });
  pi.registerTool({
    name: "schedule_list",
    label: "List schedules",
    description: "List the recurring tasks scheduled with schedule_add.",
    parameters: Type.Object({}),
    async execute() {
      const all = loadSchedules();
      return ok(all.length ? all.map((s) => `${s.id} | ${s.cron} | ${s.prompt}`).join("\n") : "No schedules.");
    },
  });
  pi.registerTool({
    name: "schedule_remove",
    label: "Remove schedule",
    description: "Remove a scheduled task by id.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id: string, params: any) {
      const all = loadSchedules();
      const rest = all.filter((s) => s.id !== params.id);
      saveSchedules(rest);
      return ok(rest.length < all.length ? `Removed ${params.id}.` : `No schedule ${params.id}.`);
    },
  });
}

// ---------- extension ----------
export default function (pi: ExtensionAPI) {
  if (!TOKEN) return; // idle unless configured
  st.pi = pi; // the extension is re-created on /new, /resume, /fork: always use the latest instance
  registerTools(pi);
  registerScheduleTools(pi);

  pi.on("session_start", async (_e, ctx) => {
    st.ctx = ctx;
    if (st.polling || !ctx.hasUI) return; // interactive/RPC sessions only; print mode (-p) must be able to exit
    if (!ALLOW.size) { ctx.ui?.notify?.("pi-telegram: set PI_TELEGRAM_ALLOWED_USERS, nobody is allowed yet", "warning"); return; }
    st.polling = true;
    log(`start, allowed=${[...ALLOW]}, timezone=${TZ}`);
    setInterval(() => { try { runDue(pi); } catch (e) { log(`scheduler error ${e}`); } }, 20_000);
    let offset = 0;
    try { offset = JSON.parse(readFileSync(STATE, "utf8")).offset || 0; } catch {}
    (async () => {
      while (st.polling) {
        let r: any;
        try { r = await api("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] }); }
        catch (e) { log(`poll error ${e}`); await new Promise((s) => setTimeout(s, 5000)); continue; }
        if (!r.ok) { log(`poll error ${r.description}`); await new Promise((s) => setTimeout(s, 10_000)); continue; }
        for (const u of r.result || []) {
          offset = u.update_id + 1;
          try { mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true }); writeFileSync(STATE, JSON.stringify({ offset })); } catch {}
          const m = u.message || {};
          const chat = m.chat || {}, uid = m.from?.id;
          let text = (m.text || m.caption || "").trim();
          if (chat.type !== "private" || !ALLOW.has(uid)) { log(`ignored update from ${uid} in ${chat.type}`); continue; }
          if (m.photo || m.document || m.voice || m.audio) {
            try {
              await api("sendChatAction", { chat_id: chat.id, action: "typing" });
              const note = await attachment(m);
              text = m.voice || m.audio ? `${text ? text + "\n\n" : ""}${note}` : `${text || "I sent you this file, take a look."}\n\n${note}`;
            } catch (e) { log(`attachment error ${e}`); await send(chat.id, `Could not fetch the file: ${e}`); continue; }
          }
          if (!text) { await send(chat.id, "Send text, a photo, a file or a voice note."); continue; }
          if (text === "/start" || text === "/help") {
            await send(chat.id, "Connected to pi. Messages go into the open pi session (and steer it if pi is busy). /stop aborts the current run, /schedules lists recurring tasks, /unschedule <id> removes one. Ask pi to do something regularly and it schedules it.");
            continue;
          }
          const c = st.ctx;
          if (text === "/stop") { c?.abort(); await send(chat.id, "Stopped."); continue; }
          if (text === "/schedules") {
            const all = loadSchedules();
            await send(chat.id, all.length ? all.map((s) => `\`${s.id}\` · \`${s.cron}\` · ${s.prompt}`).join("\n") : "No schedules yet. Just ask, e.g. \"every Monday 8am, summarise last week's sales\".");
            continue;
          }
          if (text.startsWith("/unschedule")) {
            const id = text.split(/\s+/)[1];
            const all = loadSchedules();
            saveSchedules(all.filter((s) => s.id !== id));
            await send(chat.id, all.some((s) => s.id === id) ? `Removed ${id}.` : "Usage: /unschedule <id> (see /schedules)");
            continue;
          }
          st.chat = chat.id;
          st.fromTelegram = true;
          log(`prompt ${text.length} chars`);
          try {
            if (c?.isIdle()) st.pi.sendUserMessage(`[Telegram] ${text}`);
            else st.pi.sendUserMessage(`[Telegram] ${text}`, { deliverAs: "steer" });
          } catch (e) { log(`inject error ${e}`); await send(chat.id, `Could not reach pi: ${e}`); }
        }
      }
    })();
  });

  pi.on("agent_start", async () => {
    if (!st.fromTelegram || !st.chat) return;
    const chat = st.chat;
    (async () => {
      while (st.fromTelegram && st.ctx && !st.ctx.isIdle()) {
        try { await api("sendChatAction", { chat_id: chat, action: "typing" }); } catch {}
        await new Promise((s) => setTimeout(s, 4000));
      }
    })();
  });

  pi.on("agent_end", async (event: any) => {
    if (!st.fromTelegram || !st.chat) return;
    st.fromTelegram = false;
    const msgs = (event.messages || []).filter((m: any) => m.role === "assistant");
    const last = msgs[msgs.length - 1] || {};
    let out = textOf(last).trim();
    if (!out && last.errorMessage) out = `pi error: ${last.errorMessage}`;
    log(`reply ${out.length} chars`);
    await send(st.chat, out);
  });
}
