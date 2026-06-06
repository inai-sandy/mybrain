# The Software Rulebook
*How Claude and I build software together — every project, every time.*

This is the agreement. Claude reads it at the start of every project and follows it without being told again. It has three parts:

1. **THE FLOW** — *how* work gets done (pull an issue → code → test → merge → deploy → close).
2. **THE STANDARDS** — *what* every piece of software must include and look like.
3. **THE DESIGN STANDARDS** — *how* the software is built well under the hood.

**The one promise:** Claude always knows the next step and keeps moving on its own. It never makes me answer technical questions, and it never makes me tap "go to the next issue" one by one. I talk in plain words; Claude handles the technical world and reports back in plain words.

---

# PART 1 — THE FLOW

## The three unbreakable rules
1. **Flat issues, never sub-tickets.** Every task is its own normal Linear issue. Many small issues is fine — Claude *clubs* them to work together — but never nested sub-tickets, because tomorrow I need to trace everything in one flat list.
2. **"Done" means merged AND deployed live, and confirmed running.** A task that is coded but not deployed is *not* done. (The project is pre-users, so deploying straight to the live server is fine.)
3. **No per-issue begging.** I approve a batch of issues once; Claude then runs the whole batch unattended (overnight is the point). It only checks in at the batch's edges or before a big/risky issue.

## What "tested" means
A job is tested when **(a)** the feature actually works, **and (b)** Claude has written proper automated tests that re-run every time — so a future change can't silently break it. Claude never deploys a job that isn't tested both ways.

## Part A — Plan the run *(I'm awake, takes a minute — my tracking checkpoint)*
1. Claude reviews the open Linear issues.
2. It sorts them into **small/routine** vs **big/risky**.
3. It clubs the small ones into a batch and proposes, in plain words: *"Tonight I'll finish these small issues together, then stop before the big one (X) for your OK."*
4. I tap **yes** (or adjust the grouping). That is the only approval needed for the whole night.

## Part B — Run the batch *(I'm asleep)*
For every issue in the batch, back to back, **no per-issue acknowledgement**, and **in this exact order, every time:**

1. **PULL** the issue from Linear → move it to *In Progress* → re-read its requirements.
2. **Clarity check.** Is the issue clear enough to build safely? If it's **vague → park it** for my morning clarification (do *not* guess) and move to the next issue.
3. **BRANCH** — open a fresh work-branch for this one issue.
4. **CODE** — build *only* what this issue asks. No extra, no drifting into other things.
5. **TEST** — confirm it works *and* automated tests pass. Fix anything red (try a stubborn bug up to 3 times).
6. **MERGE + DEPLOY** — merge it, deploy to the VPS, and **confirm it is live.** *(The exact server steps are captured once and locked as a checklist — see below — so this step can never be "forgotten.")*
7. **CLOSE** the Linear issue and clean up the branch.
8. **SIGN-OFF NOTE** — Claude writes "what I did / what I didn't do" and posts it to the Linear issue.
9. → **NEXT** issue automatically.

## When something goes wrong overnight
- **A coding problem** (a bug, a failing test) → try hard (up to 3 real attempts), then **park that one issue** with a note and **keep going** with the rest. The night is never wasted spinning on one blocker.
- **A decision / risky / can't-be-undone thing, or anything that costs money** → **park it immediately** for my morning OK. Claude never makes the costly or irreversible calls while I sleep.
- **A vague issue** → park for my clarification (as in step 2). Never build on a guess.
- **The stop-loss:** if **several issues fail in a row**, or the **deploy itself breaks**, **stop the whole run** and wait. That pattern means something is broken at the base (server down, main branch broken) and continuing would just pile work onto a broken foundation.

## Part C — Morning report
When the batch is done (or stopped), Claude delivers:
- a **phone notification** that it's finished,
- a **full plain-English summary in the chat** — what got done, what's deployed, what's parked and why,
- and **every issue updated in Linear** (Done, or parked-with-reason).

## The machinery that makes the flow un-skippable
*(Borrowed from real, proven projects — this is what ends the "I told Claude 100 times" problem.)*
- **A live checklist** Claude ticks off, with only **one item in progress at a time** — so no step quietly vanishes.
- **Steps locked in a fixed order**, with the order itself stated as a rule.
- **A forced sign-off note** at the end of every issue (posted to Linear) — if a step was skipped, the note exposes it.
- **Closing the Linear issue is its own required step**, never an afterthought.
- **Every rule comes with its reason** (reasons stick better than shouting).
- **Gates log-and-continue**, they don't hang (the "try 3 times then note it and move on" rule).
- **State is re-read at verify time** — Claude re-checks the issue's requirements before shipping.
- **The exact VPS deploy steps are captured once and locked** as a checklist (merge → put on server → restart → confirm live), so deploy is a fixed routine, not a memory.

---

# PART 2 — THE STANDARDS
*What every piece of software must include and look like. Claude applies these automatically; I never ask for them again. They become part of every relevant issue's checklist and are checked before deploy.*

## On every list or table
- Pagination
- A search box at the top
- Filters
- Proper, clean table formatting
- Click a column heading to sort
- A friendly "nothing here yet" message when empty
- A "loading…" indicator while data loads
- Always show the total count (e.g. "120 results")

## On every action and form
- Confirm ("are you sure?") before deleting or anything permanent
- A clear "Saved!" / "Done!" success message after an action
- Friendly error messages — never a raw crash or scary code
- Forms catch mistakes and clearly say what to fix
- File and photo uploads handled consistently — size limits, a preview, and clear progress/errors

## Look & feel, everywhere
- Works on phone and desktop (responsive)
- Consistent design throughout (same buttons, colours, spacing, fonts)
- Accessible and easy to read (good contrast, readable sizes, keyboard-friendly)
- A dark mode option
- Fast and lightweight, even with lots of data
- Dates, times and numbers shown consistently and in local format (e.g. "6 Jun 2026", "₹1,200")

## Login & security
- **Accounts** — proper sign up / log in / log out
- **Roles** — control over who can see or do what (nobody sees what they shouldn't)
- **Password & login safety** — passwords stored encrypted, strong-password rules, safe "forgot password" reset
- **Secrets & connection** — secret keys kept out of the code, app always served securely (HTTPS)
- **Auto-logout** — users are logged out after a period of inactivity, so an unattended session can't be misused

## Every app also has
- **Notifications** — email and/or in-app alerts when something important happens (e.g. "your order shipped", "someone messaged you")
- **Profile & settings page** — a standard area where each user updates their details, password, and preferences

## The Standard CRUD template
For every type of "thing" in an app (users, products, orders, etc.), "build CRUD for X" automatically means **all** of this:
- **View all (list)** → a table with every list standard above (pagination, search, filters, sort, count, loading, empty message, formatting)
- **Add new (Create)** → a form with validation + a success message
- **See details (Read)** → a clean detail view of one item
- **Edit (Update)** → a pre-filled form, same validation + success message
- **Delete** → always with a confirm
- **Consistent** look and behaviour across every type of thing, and it **respects roles** (who may add/edit/delete)

**Standard CRUD extras (always included):**
- **Bulk actions** — select several rows and act on them together
- **Export to a file** — download the list as a spreadsheet (CSV/Excel)
- **Import from a file** — upload a spreadsheet to add many records at once
- **Item history** — each record logs who changed what, and when

---

# PART 3 — THE DESIGN STANDARDS
*How the software is built well under the hood. The technical "how" is Claude's job; these are the disciplines it always follows.*

- **Organized & documented** — tidy structure and clear notes, so anything can be found and understood later.
- **Reuse, don't repeat** — build something once and reuse it everywhere instead of copy-pasting; fewer bugs, easier changes.
- **Built to grow** — designed to handle more users and more data later without breaking or slowing down.
- **Deploy straight to live** — since there are no users yet, there is no separate staging area; finished work goes straight to the live server. *(We revisit this the moment real users arrive.)*

---

# How Claude uses this rulebook
1. **Reads it at the start of every project** and treats it as binding.
2. **Adds the relevant Standards and CRUD items to every issue's checklist automatically** — I don't have to list them.
3. **Checks the Standards and tests before every deploy** — a job that's missing a standard (no pagination, no delete-confirm, etc.) does not pass.
4. **Follows THE FLOW exactly**, using the anti-skip machinery so nothing — especially deploy and closing the Linear issue — ever gets dropped.
5. **Keeps this rulebook up to date** as we refine it together.

---
*This is a living document. We keep refining it.*
