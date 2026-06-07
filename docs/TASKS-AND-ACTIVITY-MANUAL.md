# My Brain — Tasks & Activity · User Manual

*Your daily loop, and how the app comes to understand you.*

---

## 1. The big idea

Tasks & Activity isn't a to-do list. It's a daily loop designed so the app gradually understands **who you are** — where your time goes, what you finish, what you avoid, and how you feel about your days.

It has **two bookends**:

- **🌅 Morning — the plan.** You *dump your brain* and the AI turns the mess into a clean, prioritized task list.
- **🌙 Night — the understanding.** You *tell the story* of your day. This is what gives the app the human context that tasks alone can't.

Everything in between — what you finish, how long it really took, what you do across the app — is captured automatically and woven into a daily story and, over time, an honest portrait of you.

You can run the whole thing **two ways**: inside the app, or entirely from **Telegram**.

---

## 2. A day in the life

| Time | What happens |
|---|---|
| **7:00–8:30 AM** | The bot nudges you to dump your brain (stops the moment you do, or at 9 AM). |
| **You dump** | Type or speak everything on your mind → the AI makes your tasks. |
| **Through the day** | Tick tasks off; speak quick notes; get reminders and a mid-day motivational nudge. |
| **9:00–10:30 PM** | The bot nudges you to tell the day's story (until you do, or 11 PM). |
| **9:30 PM** | The AI writes your day summary and sends it to you. |
| **Every 3 days** | Your personality portrait refreshes (once you've used it for 10 days). |

---

## 3. Getting started

1. Open **mybrain.1site.ai** and sign in.
2. Tap **Tasks** in the menu — this is your **Today** screen.
3. Tap **🧠 Dump my brain**, then type or speak whatever's on your mind. Tap **Make my tasks**.
4. *(Optional but recommended)* Connect Telegram — see §9.

That's it. The more days you use it, the more it understands you.

---

## 4. The Today screen

Your daily cockpit. From here you can:

- **🧠 Dump my brain** (big button) — your morning brain-dump. Type **or tap the mic to speak**. The AI:
  - turns rambling sentences into concrete tasks ("Call the accountant", not "accountant"),
  - removes duplicates,
  - guesses a category, priority, and time estimate for each,
  - **pins your top 1–3 must-dos** with a ⭐️,
  - and if your dump is too vague, asks you **one clarifying question** instead of inventing tasks.
- **＋ Add task** (small button) — add a single task by hand.
- **Your task list** — with full search, filters (status / priority / category), sorting, and a progress bar showing how many you've finished today.
- **🌙 Tonight's story** and **Quick notes** live just below your tasks (see §6).

### Working a task

- **Tap the circle** to mark a task done. It asks **"how long did it really take?"** — one tap. (This is what powers the "where did my time go" insights.)
- **Pencil** = edit; **trash** = delete (with a confirm).

---

## 5. Understanding a task

Each task carries:

| Field | Meaning |
|---|---|
| **Title** | What to do. |
| **Category** | A bucket the AI learns (Beakn, Admin, Health, Learning…). |
| **Tags** | A few keywords. |
| **Priority** | High / Medium / Low. |
| **⭐️ Pinned** | One of your 1–3 must-dos for the day. |
| **Estimate** | The AI's guess at how long it'll take. |
| **Actual** | What it *really* took (you tap this when you finish). |
| **Reminders** | 0–4 per task; the AI picks smart times based on priority. Delivered via Telegram. |

### Carry-over

If you don't finish a task, it **automatically rolls to tomorrow**. If you keep carrying the same task, it gets flagged — first **"carried"**, then a red **"carried 3d"**. That flag is one of the most honest signals about you, and the coach will gently call it out.

---

## 6. The nightly story & quick notes

- **🌙 Tonight's story** — *mandatory by design.* A free narrative of your day: the problems, the wins, what actually happened. Type or speak it, and tap a mood (😣 / 😐 / 🙂 / 🤩). This is the emotional layer the app needs to truly understand you — and it shapes how it prioritizes and guides you tomorrow.
- **📝 Quick notes** — speak or type little notes through the day ("about to call the accountant"). They land in your timeline.

You're nudged for the story each evening (9–11 PM), but you can write it anytime.

---

## 7. The Activity section

Open **Activity** in the menu. It has four tabs:

### 🗓 Day
- A date navigator (jump to any past day).
- **Stat cards:** tasks done, time spent, follow-through %.
- **The AI day-summary** — "Sandeep, here's your day." Auto-written at 9:30 PM (or tap **Generate** anytime). It's saved to your memory (RAG + SuperMemory) so it's searchable forever.
- **Your story** for that day, with mood.
- **The timeline** — *everything* you did in the app that day: tasks finished, brain dumps, documents saved, bookmarks, ideas, skills — captured automatically.

### 📊 Insights
- 🔥 **Dump streak**, **follow-through %**, tasks done, time spent.
- **"Where your time went"** — a breakdown by category.
- **Estimate vs reality** — e.g. *"you under-estimate admin work by 2×."*
- **Tasks finished per day** chart.
- Switch between 7 / 30 / 90 days.

### 📆 Calendar
- A **GitHub-style heatmap** — darker squares = more done.
- Switch between 3 / 6 / 12 months.
- **Tap any day** to open it.

### 👤 Me (your portrait + Validate)
- Locked until you've used the app for **10 real days** — so it's built on evidence, not guesswork.
- Then: an **honest, direct portrait** of you (peak hours, follow-through, focus, procrastination patterns, how your dumps and stories read), refreshed every 3 days.
- **Every claim cites your own data** — no vague horoscope stuff.
- **Validate each insight:** tap **✓ correct** or **✗ not me**. The app respects your feedback forever — it keeps building on what you confirm and never repeats what you reject. This is how it stays accurate and never drifts.

---

## 8. The personality engine

This is the real point of the whole feature. Behind the scenes, every 3 days an AI "coach" reads across your stored tasks, stories, moods, and activity, cross-checks **what you planned vs what you did vs how you felt**, and builds a validated picture of you. It's deliberately **honest, not flattering** — it's meant to help you see yourself clearly.

It runs on **Claude Sonnet** by default (you can change this — see §10).

---

## 9. Telegram — run everything from your phone

Your bot is **@Itsmybeakn_bot**. Open it in Telegram and tap **Start** to claim it (only your chat can control it).

### Commands

| Command | What it does |
|---|---|
| `/dump` | Dump your brain → today's tasks |
| `/story` | Tell tonight's story |
| `/note` | Jot a quick note |
| `/add` | Add a single task |
| `/today` | See today's tasks (numbered) |
| `/done 2` | Mark task #2 done |
| `/activity` | Today's summary |
| `/insights` | Streak, follow-through, time |
| `/me` | Your personality snapshot |
| `/skip` | Rest day — mute nudges today |
| `/snooze` | Quiet nudges for an hour (`/snooze 30` for 30 min) |
| `/help` | List every command |

Tap the **"/" button** in Telegram to see the whole menu any time.

### Two ways to capture

- **One line:** `/dump finish proposal, call accountant, gym later`
- **Two steps:** send `/dump` alone → the bot says "go ahead" → send your next message **or a voice note**.

### Voice notes 🎙️

Send a voice note to the bot and it's transcribed automatically, then handled like a typed message. *(Works out of the box; add a valid OpenAI key in Settings → Integrations for the highest-accuracy transcription.)*

### If you send a plain message (no command)

The bot asks **"What should I do with that?"** with buttons — **🧠 Dump · 📝 Note · ➕ Task** — so nothing is ever misfiled.

### The nudges you'll receive

- 🌅 Morning dump reminders (7–8:30 AM)
- ⏰ Task reminders at their smart times
- 💪 A mid-day motivational nudge (progress-aware: a cheer when you're crushing it, a push when a must-do is untouched)
- 🌙 Evening story reminders (9–10:30 PM)
- 🌙 Your day summary at 9:30 PM

Use **`/skip`** for a guilt-free rest day, or **`/snooze`** when you need quiet.

### Security

Only the first chat to `/start` owns the bot; everyone else is ignored. To re-link a different chat, go to **Settings → Sync → Telegram → Unlink**, then `/start` again.

---

## 10. Settings worth knowing

- **Models** — the **Tasks AI model** runs the whole engine. Defaults to **Claude Sonnet**; you can pick any OpenAI or Anthropic model.
- **Prompts** — *you can read and edit the exact instructions the AI follows* for every feature (the dump→tasks planner, the day summary, the personality coach, and more). Edit the wording, **Save**, or **Reset to default** any time. Your edits apply instantly; the app fills in your data automatically.
- **Integrations** — your API keys (OpenRouter, Anthropic, OpenAI for voice, Telegram bot token).
- **Sync → Telegram** — connection status, connect/re-register, unlink.

---

## 11. Tips

- **Dump fast and messy.** Don't organize as you type — that's the AI's job. One run-on paragraph is perfect.
- **Always log the real time** when you finish a task. Two weeks of that turns "where did my time go?" from a mystery into a chart.
- **Tell the story even on bad days.** The rough days teach the app the most about you.
- **Use Telegram on busy days.** The days you won't open the app are the most revealing — let the bot capture them.
- **Validate your portrait.** A few ✓/✗ taps make it sharper and more *you* every cycle.
- **Rest days are fine.** `/skip` exists so the streak never becomes a stick.

---

## 12. Quick FAQ

**Will syncing my memory create duplicates?** No — everything the app generates is stamped and skipped on sync.

**What if my brain-dump is vague?** The AI asks one clarifying question instead of inventing tasks.

**Can I edit what the AI says?** Yes — Settings → Prompts lets you rewrite any instruction, with a Reset button.

**When does the personality portrait appear?** After 10 active days, then it refreshes every 3 days.

**Do I have to use Telegram?** No — everything works in the app. Telegram just makes it effortless on the go.

---

*My Brain is your private second brain. Everything here is yours.*
