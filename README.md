# LiquidDrop — Live P2P File Sharing

Cloudflare Worker (signaling) + Durable Object (room) + Static Assets (website).
फाइलें कभी server पर नहीं जातीं — सिर्फ WebRTC offer/answer/ICE signaling Cloudflare से होती है; file सीधे browser → browser जाती है।

## Repository structure
```
liquiddrop/
├── public/ (index.html, style.css, app.js)
├── src/worker.js
├── wrangler.jsonc
├── package.json
└── README.md
```

## Deploy — Option A: GitHub + Cloudflare (Android से आसान)
1. **GitHub** पर नया repository बनाएँ और ऊपर की सारी files (folders सहित) upload करें। `wrangler.jsonc` और `package.json` repo की root में हों।
2. **dash.cloudflare.com** पर free account बनाएँ और login करें।
3. **Workers & Pages** → **Create application** → **Import a repository (Connect to Git)** → GitHub authorize करें → अपना repo चुनें।
4. Project name `liquiddrop-file-share` रखें (यही `wrangler.jsonc` का `name` है)। Build command खाली छोड़ें/`npm install`, Deploy command: `npx wrangler deploy`।
5. **Save and Deploy** दबाएँ। पहली deploy पर `wrangler.jsonc` की `migrations` से Durable Object `Room` अपने-आप बन जाता है।
6. Deploy होने के बाद **Settings → Domains & Routes** में आपका URL दिखेगा: `https://liquiddrop-file-share.<your-subdomain>.workers.dev`

## Deploy — Option B: Wrangler (computer/Termux)
```
npm install
npx wrangler login
npx wrangler deploy
```
आख़िर में printed `workers.dev` URL कॉपी करें। लोकल टेस्ट: `npm run dev`।

## Durable Object configuration
`wrangler.jsonc` में `durable_objects.bindings` (`ROOM` → class `Room`) और `migrations` (`new_sqlite_classes: ["Room"]`) दोनों जरूरी हैं। Free plan पर SQLite-backed Durable Objects ही चलते हैं — यही config इस्तेमाल हो रहा है। Class name बदलें तो नया migration tag जोड़ें।

## Test करें
1. Mobile 1 पर URL खोलें → **Send File** → files चुनें → **Create Live Room** → 6-digit code दिखेगा।
2. Mobile 2 पर वही URL → **Join with Code** → code डालें → **Connect**।
3. Transfer अपने-आप शुरू होगा; पूरा होने पर receiver को **Download** बटन मिलेगा।

## Notes
- दोनों devices पर page खुला और screen ON रखें (transfer के दौरान background में browser रुक सकता है)।
- Receiver फ़ाइल memory/blob में जमा करता है; बहुत बड़ी फाइलें (कई GB) कम-RAM फोन पर fail हो सकती हैं।
- सिर्फ STUN इस्तेमाल है। कुछ strict mobile-carrier NAT पर direct connection नहीं बन पाता ("Connection failed"); तब दोनों को एक ही Wi-Fi/दूसरे network पर आज़माएँ, या TURN server जोड़ें (`app.js` की `ICE` सूची)।
- Room 15 मिनट में expire होता है; हर room में अधिकतम 1 sender + 1 receiver।
