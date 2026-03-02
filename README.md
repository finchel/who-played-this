# Who Played This? 🎧

A multiplayer music guessing game. Submit songs. Guess who picked what. Prove you know your people.

## How It Works

1. **Host creates a game** - gets a 4-letter room code
2. **Players join** on their phones using the room code
3. **A prompt appears** (e.g., "Your guilty pleasure karaoke song")
4. **Everyone secretly submits a song**
5. **Songs play one at a time** - everyone guesses WHO submitted it
6. **Dramatic reveal** - points for correct guesses!
7. **Bet your confidence** - 1x (safe), 2x (bold), or 3x (YOLO) for risk/reward

## Scoring

- **Correct guess:** Earn points equal to your confidence bet (1, 2, or 3)
- **Wrong guess at 2x or 3x:** Lose (confidence - 1) points
- **Nobody guessed your song:** You get +2 stealth bonus points

## Quick Start

```bash
npm install
npm start
```

Open http://localhost:3000 on any device.

## Playing with Friends

1. Make sure all phones are on the **same Wi-Fi network**
2. Find your computer's local IP (e.g., `192.168.1.42`)
3. Players open `http://192.168.1.42:3000` on their phones
4. One person creates the game, others join with the room code

To find your local IP:
- **Mac:** `ifconfig | grep "inet " | grep -v 127.0.0.1`
- **Windows:** `ipconfig` (look for IPv4 Address)
- **Linux:** `hostname -I`

## Deploy Online

### Option 1: Railway (recommended, free tier available)
1. Push to GitHub
2. Connect repo at [railway.app](https://railway.app)
3. Deploy - done. Share the URL with players.

### Option 2: Render
1. Push to GitHub
2. Create a new Web Service at [render.com](https://render.com)
3. Set build command: `npm install`
4. Set start command: `npm start`

### Option 3: Fly.io
```bash
fly launch
fly deploy
```

### Option 4: Ngrok (quick testing)
```bash
npm start
# In another terminal:
npx ngrok http 3000
```
Share the ngrok URL with players.

## Tech Stack

- **Backend:** Node.js + Express + Socket.IO
- **Frontend:** Vanilla HTML/CSS/JS (no build step)
- **Music:** YouTube search links (no API key needed)

## Tips for Best Experience

- **Use a big screen** (TV/laptop) as the host device for playing music
- **Connect to speakers** for the full effect
- The host clicks "Play on YouTube" and the music plays for everyone in the room
- **5-8 players** is the sweet spot
- **Multiple rounds** - scores carry over, play as many as you want!
