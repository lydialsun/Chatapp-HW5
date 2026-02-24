# Test Checklist

Run the app locally, then verify each feature.

## Start the app

1. **Free port 3000** (if needed): Quit any app using port 3000, or run the client on another port.
2. In the project root, run:
   ```bash
   npm start
   ```
3. Wait for:
   - `MongoDB connected` and `Server on http://localhost:3001`
   - `Compiled successfully` and `localhost:3000`
4. Open **http://localhost:3000** in your browser.

---

## 1. Chat personalization

- [ ] **Create account**: Click "Create an account". You should see **First Name** and **Last Name** fields (in addition to Username, Email, Password). Fill all, submit.
- [ ] **Log in**: Log in with that account.
- [ ] **First message**: Start a new chat and send any message (e.g. "Hi"). The AI’s first reply should **address you by name** (your first name or full name).
- [ ] **Tabs**: You should see two tabs at the top: **Chat** and **YouTube Channel Download**.

---

## 2. YouTube Channel Download tab

- [ ] Click the **YouTube Channel Download** tab.
- [ ] Page shows: Channel URL (default `https://www.youtube.com/@veritasium`), Max videos (default 10), **Download Channel Data** button.
- [ ] **With API key**: If `YOUTUBE_API_KEY` is set in `.env`, click **Download Channel Data**. A progress bar appears, then "Download JSON file". Click it and confirm a JSON file downloads with `channelTitle`, `videos` (each with title, viewCount, likeCount, etc.).
- [ ] **Without API key**: If you don’t set the key, the button will show an error (e.g. "YouTube API key not configured"). That’s expected.

---

## 3. JSON in chat

- [ ] Go back to the **Chat** tab.
- [ ] **Drag JSON**: Open `public/veritasium_channel_data.json` in Finder, drag it into the chat area. A chip should appear (e.g. "veritasium_channel_data.json · 10 videos"). You can remove it with ×.
- [ ] **Attach via button**: Click 📎, choose `public/veritasium_channel_data.json`. Same chip should appear.
- [ ] Send a message with the JSON loaded (e.g. "What can you tell me about this channel?"). The AI should refer to the loaded data and can use the tools below.

---

## 4. Tool: compute_stats_json

- [ ] With channel JSON loaded, send: **"What’s the average view count?"** or **"Compute stats for likeCount"**.
- [ ] The AI should call `compute_stats_json` and reply with mean, median, std, min, max (and possibly show "🔧 1 tool used" in the message).

---

## 5. Tool: plot_metric_vs_time

- [ ] With channel JSON loaded, send: **"Plot view count over time"** or **"Plot viewCount vs time"**.
- [ ] A **line chart** should appear in the reply (metric vs date).
- [ ] Click **Enlarge** → chart opens in a modal; click outside or **Close** to dismiss.
- [ ] Click **Download CSV** → a CSV file downloads.

---

## 6. Tool: play_video

- [ ] With channel JSON loaded, send: **"Play the first video"** or **"Play the most viewed video"** or **"Play the asbestos video"** (if a title matches).
- [ ] A **card** with video **title** and **thumbnail** appears.
- [ ] **Click the card** → the video opens in a **new tab** on YouTube.

---

## 7. Tool: generateImage

- [ ] **Optional** (needs backend image generation): Drag an **image** into the chat and type e.g. **"Generate an image in this style but with a sunset"**. If the backend supports it, a generated image appears with **Download** and **Enlarge**.
- [ ] If you see "Image generation not available" or an API error, ensure the server has `REACT_APP_GEMINI_API_KEY` and that the model supports image generation; otherwise you can skip this for a quick test.

---

## 8. General

- [ ] **New Chat** clears the current conversation; channel JSON is cleared for the new chat.
- [ ] **Sessions** in the sidebar: switching sessions loads that chat; creating a new chat and sending a message creates a new session.
- [ ] **CSV** still works: drag a CSV, ask for stats or a chart (CSV tools and YouTube tools are separate; CSV uses the original tools).

---

## Quick one-shot test (no YouTube API key)

1. `npm start` → open http://localhost:3000
2. Create account (First + Last name, username, email, password) → Log in
3. Confirm the AI uses your name in the first reply
4. Open **YouTube Channel Download** tab → confirm UI and (optional) error message if no API key
5. Back to **Chat** → drag `public/veritasium_channel_data.json` into the chat
6. Send: **"Plot viewCount vs time"** → chart appears, Enlarge and Download work
7. Send: **"Play the first video"** → card appears, click opens YouTube in new tab
8. Send: **"What’s the average like count?"** → stats in reply

If all of the above pass, the main features are working.
