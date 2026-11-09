# Generate a final video from weekly updates

This guide follows the weekly pipeline implemented in this repository. Run commands from the repository root. The pipeline runs locally; the deployed Worker collects candidates and stores each edition.

The result is a Turkish narrated video, targeting roughly 2–5 minutes, rendered as a 1920×1080, 30 fps H.264 MP4, plus a PNG thumbnail and a public Turkish digest at `/weekly/<week>`.

## Schedule Saturday preparation and approve after review

After the one-time setup, install the current user's Saturday **09:00** job:

```bash
make cron-install
```

The schedule uses the computer's system time zone. This installer preserves your other cron jobs and replaces only its own marked entry when run again. The computer must be on and awake; ordinary cron does not catch up a run missed during shutdown or sleep. Edit the installed schedule with `crontab -e` if you want a different time.

Every Saturday, the job runs `make prepare`, which selects saved stories for the **current UTC ISO week**, translates them, generates a script, and sends a desktop notification through `notify-send`. A Saturday edition includes the week's snapshots available by that morning; it does not include later Saturday or Sunday stories. This differs from the older `video-draft` target's default of the previous week.

Review the `script.md` path in the notification, optionally edit it, then run from the repository root:

```bash
make approve
```

This remembers the prepared week from `video/out/pending-week`, validates and approves the script, synthesizes narration, renders, and uploads. You do not need to repeat the week, even if review happens after the next Monday. Upload visibility still follows `YOUTUBE_PRIVACY`; public release of a private upload remains a YouTube Studio action.

You can also prepare manually with `make prepare` or `make prepare WEEK=2026-W44`. If an edition is already awaiting review, preparation sends a reminder and preserves it rather than overwriting it with a new week. Existing scripts created outside this workflow are also protected from overwriting; finish those with the individual video targets instead.

Desktop notifications require `notify-send` and an active graphical session for the same user. Cron connects to the user's standard D-Bus session at `/run/user/<uid>/bus`; if that session is unavailable, the draft remains saved and the log reports the notification failure. Notification delivery is best effort, not an email or push notification. A failed pipeline stage also attempts a failure notification.

Read scheduled output with:

```bash
tail -n 80 video/out/cron.log
```

Preparation and approval share a lock to prevent overlapping runs. A failed production keeps the pending week for another `make approve` attempt after resolving the error. If the edition has already reached `published` on the Worker, use the individual upload recovery instructions instead; repeating approval cannot move its status backwards. To remove the schedule, delete the `BEGIN news.emre.xyz weekly preparation` through `END news.emre.xyz weekly preparation` block in `crontab -e`.

## What the latest updates provide

The current checkout includes:

- Daily candidate snapshots, weekly ranking, and deduplication by URL and story cluster.
- Turkish translation and narration generation through an OpenAI-compatible LLM endpoint.
- An editable Markdown script and an approval gate before voice, rendering, or upload.
- ElevenLabs narration, word timing, synchronized captions, and Remotion rendering with story images or branded fallback cards.
- YouTube OAuth, video upload, chapters, source links, and weekly-page embedding.
- Upload recovery (`6c4ef34`): save the uploaded video ID locally and on the Worker before setting the thumbnail and marking the edition published. A thumbnail failure warns instead of discarding the video ID.

The workflow is:

```text
Weekly candidates → select → translate → script → manual review
→ approve → voice → render → review MP4 → upload → review in YouTube Studio
```

## 1. Prepare the project once

You need NVM with the Node version in `.nvmrc` (currently 22), the video dependencies, and a working deployed news Worker with its database migrations applied.

```bash
make video-init
```

This installs `video/` dependencies and creates `video/.env` if it does not already exist. It preserves an existing environment file.

For a new Worker installation, follow the setup in [README.md](README.md#setup--deployment) first. Existing installations need the weekly migrations, including `worker/migrations/0005_weekly_editions.sql`, applied to the database used by `NEWS_API_BASE_URL`. The existing deployment commands are `make db-migrate` and `make deploy`; run them only when that installation needs updating.

Rendering uses Remotion's browser renderer. The machine must support its browser and have access to any browser download and story-image URLs it needs. A browser startup failure must be resolved before rendering can finish.

## 2. Configure `video/.env`

Edit `video/.env` with your values. Keep credentials out of Git; `video/.env` and `video/out/` are gitignored.

```dotenv
NEWS_API_BASE_URL=https://news.emre.xyz
INGESTION_SECRET=replace-with-the-workers-admin-secret

AI_GATEWAY_BASE_URL=https://ai.workouse.com/compat
AI_GATEWAY_API_KEY=replace-with-your-gateway-key
AI_MODEL=replace-with-your-model-id
CF_ACCESS_CLIENT_ID=
CF_ACCESS_CLIENT_SECRET=

ELEVENLABS_API_KEY=replace-with-your-elevenlabs-key
ELEVENLABS_VOICE_ID=replace-with-your-turkish-capable-voice-id
ELEVENLABS_MODEL_ID=eleven_multilingual_v2

YOUTUBE_CLIENT_ID=replace-with-your-desktop-oauth-client-id
YOUTUBE_CLIENT_SECRET=replace-with-your-desktop-oauth-client-secret
YOUTUBE_REFRESH_TOKEN=
YOUTUBE_PRIVACY=private

VIDEO_ITEM_COUNT=6
```

- `INGESTION_SECRET` must match the deployed Worker's admin Bearer secret. The CLI requires it even for `auth`.
- The gateway must accept OpenAI-compatible chat-completion requests with Bearer authentication. The CLI appends `/chat/completions` to the configured base URL when needed.
- For this Cloudflare AI Gateway custom domain, use `https://ai.workouse.com/compat`, which produces `https://ai.workouse.com/compat/chat/completions`. A bare hostname produces an `Invalid provider` error. Keep `AI_MODEL=dynamic/audit` if `audit` is the deployed dynamic route in this gateway. Other OpenAI-compatible services may use a different base path. See [Cloudflare custom domains](https://developers.cloudflare.com/ai-gateway/configuration/custom-domains/) and [dynamic routes](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/usage/).
- If Cloudflare Access protects the gateway, set both `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` to your Access service-token credentials. Translation and script requests send them as `CF-Access-Client-Id` and `CF-Access-Client-Secret`, alongside gateway authentication. The Access application must have a Service Auth policy allowing that service token. Keep `AI_GATEWAY_API_KEY` set to the gateway API token; it is a separate credential. See [Cloudflare service-token authentication](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).
- Set both ElevenLabs credentials for real narration. If both are missing, the current implementation generates silent mock audio automatically. Render and upload do not currently reject that audio. Do not use mock audio for the final video.
- Set `NEWS_API_BASE_URL` and `ELEVENLABS_MODEL_ID` explicitly, rather than leaving their template entries empty.
- `VIDEO_ITEM_COUNT` defaults to six and accepts 1–20. The actual selection may contain fewer stories if there are fewer distinct candidates.
- `YOUTUBE_PRIVACY=private` lets you review the upload before making it public. `unlisted` and `public` are also accepted.

Explicitly exported shell variables override `video/.env`. If changing the file appears to have no effect, check for an older exported value in your shell.

YouTube credentials are only needed for authentication and upload. You can create a local MP4 without them using step 7's staged commands.

## 3. Connect YouTube once, if uploading

In your Google Cloud project, enable YouTube Data API v3, configure the OAuth consent screen for the account you will use, and create a Desktop app OAuth client. Put its client ID and secret into `video/.env`.

```bash
make video-auth
```

1. Open the authorization URL printed in the terminal.
2. Sign in to the intended YouTube account and grant access.
3. Let the browser return to the loopback callback at `http://127.0.0.1:<port>`.
4. Copy the refresh token printed in the terminal into `YOUTUBE_REFRESH_TOKEN` in `video/.env`.

The command does not save the token automatically. Run it where the browser can reach the CLI's loopback listener; a browser on another machine cannot directly reach that listener. The callback times out after five minutes.

## 4. Choose the week and check candidate availability

Use one explicit ISO week throughout the run:

```bash
export WEEK=2026-W42
```

Replace this example with your target week. Without `WEEK`, the CLI defaults to the previous ISO week in UTC, not the current week.

The Worker snapshots live stories daily at 03:00 UTC when its scheduled trigger runs. It captures the top 30 candidates plus liked articles. Regular snapshots matter because live articles can expire before the end of a week.

If you need an immediate snapshot, the admin API supports the following optional command. These shell variables must be set separately; `curl` does not load `video/.env`:

```bash
export NEWS_API_BASE_URL=https://news.emre.xyz
read -r -s -p 'Worker INGESTION_SECRET: ' INGESTION_SECRET
export INGESTION_SECRET
printf '\n'
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${INGESTION_SECRET}" \
  "${NEWS_API_BASE_URL}/api/admin/weekly/snapshot"
```

The response reports `week` and `candidateCount`. A manual snapshot always captures the **current UTC week**. It cannot backfill an older week by supplying `WEEK`; that shell variable only controls the video commands below. If your target week has no saved candidates, stop and resolve the missing data before drafting it.

## 5. Generate and review the draft

```bash
make video-draft WEEK="$WEEK"
```

This runs `select`, `translate`, and `script` in order:

| File under `video/out/<week>/` | Purpose |
| --- | --- |
| `selection.json` | Ranked stories, with liked stories prioritized and duplicates removed |
| `translation.json` | Turkish edition title, introduction, and story summaries |
| `script.md` | Editable narration script |
| `script.json` | Structured narration consumed by production commands |

Translation also saves a `draft` edition on the Worker. Drafts are not listed as public weekly editions.

Open `video/out/<week>/script.md` and review the facts, Turkish wording, pronunciation, introduction, story order, and ending. Keep its generated structure:

```markdown
## Intro

Turkish opening narration.

## Story 1: https://original-story.example/article
### Turkish story headline

Turkish narration for this story.

## Outro

Turkish closing narration.
```

Keep all story URLs intact and story numbers sequential. Keep the complete spoken narration between **280 and 2000 words** across the intro, story narration, and outro; headings do not count. This budget scales with the story count (about 2–14 minutes), but actual duration depends on the synthesized speech.

Review `translation.json` too: digest summaries and the edition title come from translation, while narration comes from the script. Editing `script.md` does not update the digest's translated title or summaries. Resolve any digest corrections before approval; do not assume a script edit changes both outputs.

Do not rerun `video-draft` just to save editorial changes: it regenerates local draft artifacts, including your script. It also attempts to write `draft` status, which is rejected once the edition has advanced to `approved` or `published`.

## 6. Approve the script and publish the web digest

```bash
make video-approve WEEK="$WEEK"
```

This parses the edited `script.md`, validates its structure and word budget, rewrites `script.json`, and stores the script on the Worker with status `approved`.

**Approval makes the Turkish digest publicly accessible**, before any video is uploaded:

```text
https://news.emre.xyz/weekly/<week>
```

Use your configured site's base URL if different. Open the page and check its summaries and links. Voice, render, and upload require an approved or published edition.

After approval, keep the local script unchanged while producing the video. The current gate checks edition status; it does not verify that local script contents still match the approved version. If you edit narration before upload, run approval again, then voice and render again.

## 7. Generate the final MP4

### Combined production command

If you want generation and YouTube upload to run together:

```bash
make video-produce WEEK="$WEEK"
```

This runs `voice → render → upload` immediately. It does not pause for local video review. Check your ElevenLabs configuration and YouTube privacy setting before running it.

### Generate locally and review before upload

The existing Makefile bundles production into one target. To run individual stages through Make without modifying it, paste this Bash helper once into your terminal from the repository root. The indented recipe line below must begin with a tab.

```bash
weekly_step() {
  make --no-print-directory -f Makefile -f - video-step STEP="$1" WEEK="$WEEK" <<'MAKE'
.PHONY: video-step
video-step:
	bash -c '$(NVM_CMD) cd video && node --experimental-strip-types src/cli.ts $(STEP) --week $(WEEK)'
MAKE
}
```

Then run each stage separately:

```bash
weekly_step voice
```

Listen to the MP3s in `video/out/<week>/audio/`. Segment `0` is the intro, `1` through the story count are stories, and the last segment is the outro. Each accompanying JSON file contains timing, captions, and a `mock` flag. For a final narrated video, confirm `mock` is `false` and that speech is audible.

```bash
weekly_step render
```

Your final local files are:

```text
video/out/<week>/video.mp4
video/out/<week>/thumbnail.png
```

Open the MP4 in a video player and check narration, caption timing, Turkish characters, story order, image/card presentation, and the ending. Inspect the PNG separately. Missing or failed story-image downloads use branded cards.

You can stop here if you only need the final video file. Keep `video/out/<week>/` as the working archive; it also contains the audio, timing metadata, and downloaded images.

## 8. Upload and publish

If you used the staged path and the local video is ready:

```bash
weekly_step upload
```

The upload builds Turkish metadata with chapters and source links, uploads the MP4, saves the YouTube video ID in `video/out/<week>/upload.json` and on the Worker, attempts to set the thumbnail, then marks the edition `published`.

The weekly page now includes the YouTube embed. The Worker's `published` status does **not** change YouTube visibility: a private upload remains private and will not play for ordinary visitors to the digest.

In YouTube Studio, review playback, title, description, chapters, thumbnail, and visibility. Make the video public when ready, then check playback on the public weekly page.

## 9. Resume or correct a run

Stop on an error, read its message, and resolve the cause before retrying the affected stage. Use the staged helper above to avoid repeating unrelated stages.

| Situation | Action |
| --- | --- |
| No weekly candidates | Check the requested ISO week and snapshot collection. A snapshot today cannot recreate last week's missing data. |
| Admin API returns 401 | Check `NEWS_API_BASE_URL` and that `INGESTION_SECRET` matches that Worker. |
| LLM configuration or response fails | Check the gateway URL, Bearer key, model, and reported validation error. Retry the failed `translate` or `script` stage with the helper while the edition is still a draft. |
| Approval rejects the script | Correct the required headings, sequential story numbers, nonempty narration, or 280–2000 word budget; rerun `make video-approve WEEK="$WEEK"`. |
| Production says the edition is a draft | Complete script review and approval first. |
| Audio is silent or the log says `[mock]` | Set both ElevenLabs credentials, run `weekly_step voice`, listen again, then rerender. Changing from mock to real mode invalidates the matching mock cache. |
| ElevenLabs reports an invalid model ID | Set `ELEVENLABS_MODEL_ID=eleven_multilingual_v2` in `video/.env`, the pipeline's default for Turkish narration. Model IDs must match the API identifiers exactly; `eleven-v4-turbo` is invalid. Check for an exported shell value overriding the file before retrying voice. |
| Narration needs a correction before upload | Edit `script.md`, approve again, then rerun voice and render. Voice reuses unchanged narration segments. |
| Voice settings changed but audio was skipped | The cache checks narration and mock mode, not voice/model settings. Back up and remove the affected MP3/JSON pairs from this week's `audio/` directory before regenerating them. |
| Rendering fails | Check the reported browser, dependency, or missing-audio error. Resolve it and rerun `weekly_step render`. |
| Upload completed but a later Worker update failed | Preserve `upload.json` and rerun `weekly_step upload`. When a saved video ID exists, the command finishes remaining steps without uploading the MP4 again. |
| Thumbnail upload warns but the edition publishes | Set the thumbnail manually in YouTube Studio. A fully published edition with a video ID skips subsequent upload runs, including thumbnail retries. |
| Receipt is corrupt or video IDs disagree | Stop and compare `upload.json`, the Worker edition, and YouTube Studio. Resolve the discrepancy manually; do not delete the receipt just to force a new upload. |
| Process stopped during the video transfer, before an ID was saved | Check YouTube Studio for an existing upload before retrying. The saved-ID recovery cannot identify a completed upload whose ID was never recorded. |

Once an edition is published with a video ID, rerunning upload does not replace its video or change its visibility. Review any replacement or correction manually before changing published state. Edition status moves forward only: `draft → approved → published`.

## Repeat next week

After one-time setup, the combined weekly routine is:

```bash
export WEEK=2026-W43
make video-draft WEEK="$WEEK"
```

Review and edit `video/out/<week>/script.md`, then:

```bash
make video-approve WEEK="$WEEK"
make video-produce WEEK="$WEEK"
```

Review the uploaded video in YouTube Studio and make it public when ready. Use the staged path instead when you want to review the local MP4 before upload.

## Weekly Shorts and Instagram Reels

After the full weekly edition is approved and its YouTube upload has produced
`video/out/<week>/upload.json`, draft the vertical companion videos:

```sh
make shorts-draft WEEK=2026-W45
# Edit video/out/2026-W45/shorts/shorts.md, retaining its headings and field labels.
make shorts-produce WEEK=2026-W45
```

The CLI uses `video/out/` as its output root. Generated drafts contain a 5–9-word
Turkish hook, three 12–16-word topic mentions, and a fixed CTA appended by code.
Edited topic lines may contain 1–24 words to allow brief additions or shorter
wording. Keep them near 15 words: the final 36-second duration limit still applies.
The editable document controls titles, hooks, topic lines, captions, and hashtags;
it cannot replace the CTA. Drafting refuses to overwrite an existing Markdown
file: move it aside explicitly to generate a fresh draft.

Only stories in both the approved edition and its approved narration qualify.
URL aliases and shared story clusters count once. The output count is
`min(4, floor(eligible / 3))`: nine eligible stories yield three shorts, twelve
or more yield four, three to eight yield one or two. Fewer than three fail.
Production revalidates edited story URLs and rejects duplicates or unapproved
stories. It checks `upload.json` before requesting ElevenLabs audio.

Outputs live in `video/out/<week>/shorts/`: `1.mp4` through `4.mp4` as applicable,
`1-cover.png` through `4-cover.png`, and `posting.md`. One 1080×1920, 30 fps MP4
serves both platforms. Mobile page captures use a 430px viewport at 3× with a
2400 CSS-pixel height cap and fall back to the story image, then a source card.
Narration timestamps drive the scene changes. The end card stays at least six
seconds, the total duration is at least 31 seconds, and anything over 36 seconds
fails with an instruction to shorten the script. Audio caches include narration,
voice, model, and mock mode; editing spoken lines invalidates cached narration.

Look and sound: captions show four words at a time and highlight the word being
spoken, driven by the aligned word timings. A code-drawn robot presenter lip-syncs
to the same timings (mouth shape follows the vowel being spoken) over an animated
background whose colour changes per section. A quiet looping music bed
(`video/assets/music/bed.mp3`, about 12% volume, ducked to 6% under speech, faded
in and out) is mixed under the narration. The bed is synthesized with ffmpeg only
(96 BPM, Am–F–C–G), so there are no licensing concerns; regenerate or tweak it with
`make shorts-music` (edit `video/scripts/generate-music.sh`). To use your own
track, replace `bed.mp3` with a licensed file. Without the file, shorts render
without music and print a warning.

For an explicit silent mock render, use `make shorts-produce WEEK=2026-W45 MOCK=1`.
This writes to the same shorts directory and labels the posting notes as mock.
Run production again without `MOCK=1` before posting. There is no auto-upload,
Worker write, database change, or cron integration in this workflow.

`posting.md` includes the full `youtu.be` link from `upload.json`, titles,
platform captions, hashtags, and suggested Monday/Wednesday/Friday/Sunday dates
in the week after the edition. Choose the posting time manually.

YouTube confirms that Shorts description/comment URLs are not clickable. In
YouTube Studio, open Content, select the uploaded Short, set **Related video**
to the full weekly video, and save. This requires advanced feature access and a
public or unlisted full video. On Instagram, put the full-video link in the
profile's Links section and direct viewers to the bio. Caption links have been
tested for some Meta Verified accounts; do not assume availability for Reels.
Use the PNG for the Instagram cover; select an opening frame in YouTube's mobile
Shorts flow where supported.

Sources checked 2026-11-09:

- [YouTube link behavior](https://support.google.com/youtube/answer/13748639)
- [YouTube Related video](https://support.google.com/youtube/answer/14075157)
- [Instagram's limited caption-link test](https://www.socialmediatoday.com/news/instagram-tests-links-in-post-captions-for-paying-users/814763/)
